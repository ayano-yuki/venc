mod filesystem;
use anyhow::{bail, ensure, Context, Result};
pub use filesystem::{FsError, Stat};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use venc_crypto::{expand, new_key, open, open_key, random, seal, Kdf, Key, Sealed};
use zeroize::{Zeroize, Zeroizing};

pub const MAX_FILE_SIZE: usize = 16 * 1024 * 1024;
const MAX_METADATA: usize = 16 * 1024 * 1024;
const MAX_JSON: usize = 128 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    format: String,
    version: u32,
    vault_id: String,
    kdf: Kdf,
    vmk_wrap: Sealed,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    object: String,
    size: usize,
    wrapped_key: Sealed,
    #[serde(default)]
    ctime: u64,
    #[serde(default)]
    mtime: u64,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    files: BTreeMap<String, Entry>,
    #[serde(default)]
    directories: BTreeMap<String, u64>,
}
impl Drop for Metadata {
    fn drop(&mut self) {
        for (mut name, _) in std::mem::take(&mut self.directories) {
            name.zeroize();
        }
        let files = std::mem::take(&mut self.files);
        for (mut name, _) in files {
            name.zeroize();
        }
    }
}

/// One process owns an exclusive vault lock. Dropping or locking erases its keys.
pub struct Session {
    root: PathBuf,
    header: Header,
    master: Option<Key>,
    metadata: Metadata,
    guard: Option<File>,
}

fn id() -> Result<String> {
    Ok(random::<16>()?.iter().map(|x| format!("{x:02x}")).collect())
}
fn valid_id(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_path(s: &str) -> Result<()> {
    ensure!(
        !s.is_empty()
            && s.len() <= 4096
            && !s.contains(['\\', '\0', ':'])
            && s.split('/').all(|p| !p.is_empty() && p != "." && p != ".."),
        "invalid vault path"
    );
    Ok(())
}
fn aad(vault: &str, kind: &str, object: &str) -> Vec<u8> {
    format!("venc/v1/{kind}/{vault}/{object}").into_bytes()
}
fn read_bounded(path: &Path, max: usize) -> Result<Vec<u8>> {
    ensure!(
        fs::symlink_metadata(path)?.is_file(),
        "expected a regular file"
    );
    let mut bytes = Vec::new();
    File::open(path)?
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= max, "file exceeds size limit");
    Ok(bytes)
}
fn private_dir(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}
fn options() -> OpenOptions {
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts
}
fn sync_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("missing parent")?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| e.error)?;
    sync_dir(parent)
}
fn acquire(root: &Path) -> Result<File> {
    let path = root.join(".session.lock");
    ensure!(
        fs::symlink_metadata(&path)?.is_file(),
        "invalid session lock"
    );
    let guard = OpenOptions::new().read(true).write(true).open(path)?;
    guard
        .try_lock_exclusive()
        .context("vault is already open in another process")?;
    ensure!(
        fs::symlink_metadata(root.join("objects"))?.is_dir(),
        "invalid objects directory"
    );
    Ok(guard)
}
impl Session {
    pub fn init(path: &Path, password_a: &[u8], password_b: &[u8]) -> Result<Self> {
        // Derive before touching disk. Never initialize over an existing directory.
        let kdf = Kdf::new()?;
        let kek = kdf.derive(password_a, password_b)?;
        let master = new_key()?;
        let vault_id = id()?;
        let vmk_wrap = seal(&kek, &master[..], &aad(&vault_id, "vmk-wrap", ""))?;
        let header = Header {
            format: "venc".into(),
            version: 1,
            vault_id,
            kdf,
            vmk_wrap,
        };
        private_dir(path)?;
        let root = fs::canonicalize(path)?;
        private_dir(&root.join("objects"))?;
        let guard = options().open(root.join(".session.lock"))?;
        guard.try_lock_exclusive()?;
        let session = Self {
            root,
            header,
            master: Some(master),
            metadata: Metadata::default(),
            guard: Some(guard),
        };
        session.persist_metadata(&session.metadata)?;
        atomic_write(
            &session.root.join("vault.json"),
            &serde_json::to_vec(&session.header)?,
        )?;
        sync_dir(session.root.parent().context("missing parent")?)?;
        Ok(session)
    }
    pub fn unlock(path: &Path, password_a: &[u8], password_b: &[u8]) -> Result<Self> {
        let root = fs::canonicalize(path)?;
        let guard = acquire(&root)?;
        let header: Header =
            serde_json::from_slice(&read_bounded(&root.join("vault.json"), 16384)?)?;
        ensure!(
            header.format == "venc" && header.version == 1 && valid_id(&header.vault_id),
            "unsupported vault format"
        );
        ensure!(
            header.vmk_wrap.ciphertext.len() == 48,
            "invalid wrapped master key"
        );
        let kek = header.kdf.derive(password_a, password_b)?;
        let master = open_key(
            &kek,
            &header.vmk_wrap,
            &aad(&header.vault_id, "vmk-wrap", ""),
        )?;
        let meta_key = expand(&master[..], header.vault_id.as_bytes(), b"venc/v1/metadata")?;
        let sealed: Sealed =
            serde_json::from_slice(&read_bounded(&root.join("metadata.enc"), MAX_JSON)?)?;
        ensure!(
            sealed.ciphertext.len() <= MAX_METADATA + 16,
            "metadata exceeds size limit"
        );
        let plain = open(&meta_key, &sealed, &aad(&header.vault_id, "metadata", ""))?;
        ensure!(plain.len() <= MAX_METADATA, "metadata exceeds size limit");
        let metadata: Metadata = serde_json::from_slice(&plain)?;
        for path in metadata.files.keys().chain(metadata.directories.keys()) {
            valid_path(path)?;
            ensure!(
                !(metadata.files.contains_key(path) && metadata.directories.contains_key(path)),
                "file/directory conflict"
            );
            let mut ancestor = path.as_str();
            while let Some((parent, _)) = ancestor.rsplit_once('/') {
                ensure!(
                    !metadata.files.contains_key(parent),
                    "file/directory conflict"
                );
                ancestor = parent;
            }
        }
        for entry in metadata.files.values() {
            ensure!(
                valid_id(&entry.object)
                    && entry.size <= MAX_FILE_SIZE
                    && entry.wrapped_key.ciphertext.len() == 48,
                "invalid file metadata"
            );
        }
        Ok(Self {
            root,
            header,
            master: Some(master),
            metadata,
            guard: Some(guard),
        })
    }
    fn master(&self) -> Result<&Key> {
        self.master.as_ref().context("vault is locked")
    }
    fn wrap_key(&self) -> Result<Key> {
        expand(
            &self.master()?[..],
            self.header.vault_id.as_bytes(),
            b"venc/v1/fek-wrap",
        )
    }
    fn persist_metadata(&self, metadata: &Metadata) -> Result<()> {
        let plain = Zeroizing::new(serde_json::to_vec(metadata)?);
        ensure!(plain.len() <= MAX_METADATA, "metadata exceeds size limit");
        let key = expand(
            &self.master()?[..],
            self.header.vault_id.as_bytes(),
            b"venc/v1/metadata",
        )?;
        let sealed = seal(&key, &plain, &aad(&self.header.vault_id, "metadata", ""))?;
        atomic_write(
            &self.root.join("metadata.enc"),
            &serde_json::to_vec(&sealed)?,
        )
    }
    fn commit(&mut self, metadata: Metadata) -> Result<()> {
        if let Err(err) = self.persist_metadata(&metadata) {
            // A sync error may happen after rename. Require a fresh unlock instead
            // of making another write using potentially stale in-memory metadata.
            self.lock();
            return Err(err.context("metadata commit failed; session locked"));
        }
        self.metadata = metadata;
        Ok(())
    }
    pub fn add(&mut self, path: &str, plain: &[u8]) -> Result<()> {
        self.master()?;
        valid_path(path)?;
        ensure!(plain.len() <= MAX_FILE_SIZE, "file exceeds 16 MiB limit");
        ensure!(
            !self
                .metadata
                .files
                .keys()
                .any(|p| p.starts_with(&format!("{path}/")) || path.starts_with(&format!("{p}/"))),
            "file/directory conflict"
        );
        ensure!(!self.is_directory(path), "file/directory conflict");
        let object = id()?;
        let fek = new_key()?;
        let wrapped_key = seal(
            &self.wrap_key()?,
            &fek[..],
            &aad(&self.header.vault_id, "fek-wrap", &object),
        )?;
        let sealed = seal(&fek, plain, &aad(&self.header.vault_id, "file", &object))?;
        let objects = self.root.join("objects");
        ensure!(
            fs::symlink_metadata(&objects)?.is_dir(),
            "invalid objects directory"
        );
        let mut file = options().open(objects.join(format!("{object}.enc")))?;
        file.write_all(&serde_json::to_vec(&sealed)?)?;
        file.sync_all()?;
        sync_dir(&objects)?;
        let mut metadata = self.metadata.clone();
        metadata.files.insert(
            path.into(),
            Entry {
                object,
                size: plain.len(),
                wrapped_key,
                ctime: self
                    .metadata
                    .files
                    .get(path)
                    .map_or_else(filesystem::now, |entry| entry.ctime),
                mtime: self
                    .metadata
                    .files
                    .get(path)
                    .map_or_else(filesystem::now, |entry| {
                        filesystem::now().max(entry.mtime.saturating_add(1))
                    }),
            },
        );
        self.commit(metadata)
    }
    pub fn extract(&self, path: &str) -> Result<Zeroizing<Vec<u8>>> {
        self.master()?;
        valid_path(path)?;
        let entry = self.metadata.files.get(path).context("file not found")?;
        ensure!(
            fs::symlink_metadata(self.root.join("objects"))?.is_dir(),
            "invalid objects directory"
        );
        let sealed: Sealed = serde_json::from_slice(&read_bounded(
            &self
                .root
                .join("objects")
                .join(format!("{}.enc", entry.object)),
            MAX_JSON,
        )?)?;
        ensure!(
            sealed.ciphertext.len() == entry.size + 16,
            "invalid encrypted file length"
        );
        ensure!(
            entry.wrapped_key.ciphertext.len() == 48,
            "invalid wrapped file key"
        );
        let fek = open_key(
            &self.wrap_key()?,
            &entry.wrapped_key,
            &aad(&self.header.vault_id, "fek-wrap", &entry.object),
        )?;
        let plain = open(
            &fek,
            &sealed,
            &aad(&self.header.vault_id, "file", &entry.object),
        )?;
        ensure!(plain.len() == entry.size, "file size mismatch");
        Ok(plain)
    }
    pub fn list(&self) -> Result<Vec<(&str, usize)>> {
        self.master()?;
        Ok(self
            .metadata
            .files
            .iter()
            .map(|(p, e)| (p.as_str(), e.size))
            .collect())
    }
    pub fn remove(&mut self, path: &str) -> Result<()> {
        self.master()?;
        let mut metadata = self.metadata.clone();
        let (mut removed, _) = metadata
            .files
            .remove_entry(path)
            .context("file not found")?;
        removed.zeroize();
        // Old objects are retained: deleting first could corrupt a committed state.
        self.commit(metadata)
    }
    pub fn change_passwords(
        &mut self,
        old_a: &[u8],
        old_b: &[u8],
        new_a: &[u8],
        new_b: &[u8],
    ) -> Result<()> {
        self.master()?;
        let old_kek = self.header.kdf.derive(old_a, old_b)?;
        let master = open_key(
            &old_kek,
            &self.header.vmk_wrap,
            &aad(&self.header.vault_id, "vmk-wrap", ""),
        )?;
        let kdf = Kdf::new()?;
        let kek = kdf.derive(new_a, new_b)?;
        let vmk_wrap = seal(
            &kek,
            &master[..],
            &aad(&self.header.vault_id, "vmk-wrap", ""),
        )?;
        let header = Header {
            format: "venc".into(),
            version: 1,
            vault_id: self.header.vault_id.clone(),
            kdf,
            vmk_wrap,
        };
        if let Err(err) = atomic_write(&self.root.join("vault.json"), &serde_json::to_vec(&header)?)
        {
            self.lock();
            bail!("password commit failed; session locked: {err}");
        }
        self.header = header;
        Ok(())
    }
    pub fn is_locked(&self) -> bool {
        self.master.is_none()
    }
    pub fn vault_id(&self) -> &str {
        &self.header.vault_id
    }
    pub fn lock(&mut self) {
        self.master = None;
        self.metadata = Metadata::default();
        self.guard = None;
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.lock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lifecycle_and_password_change() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("vault");
        let mut s = Session::init(&root, b"alpha", b"beta")?;
        assert!(Session::unlock(&root, b"alpha", b"beta").is_err());
        s.add("src/secret.txt", b"hello secret")?;
        let metadata_before = fs::read(root.join("metadata.enc"))?;
        let object = s.metadata.files["src/secret.txt"].object.clone();
        let object_path = root.join("objects").join(format!("{object}.enc"));
        let object_before = fs::read(&object_path)?;
        assert!(s.add("../escape", b"x").is_err());
        assert!(s.add("src", b"x").is_err());
        assert!(s
            .change_passwords(b"bad", b"beta", b"new-a", b"new-b")
            .is_err());
        s.change_passwords(b"alpha", b"beta", b"new-a", b"new-b")?;
        assert_eq!(fs::read(root.join("metadata.enc"))?, metadata_before);
        assert_eq!(fs::read(&object_path)?, object_before);
        s.lock();
        assert!(s.extract("src/secret.txt").is_err());
        assert!(s.add("x", b"x").is_err());
        assert!(Session::unlock(&root, b"alpha", b"beta").is_err());
        let mut s = Session::unlock(&root, b"new-a", b"new-b")?;
        assert_eq!(&*s.extract("src/secret.txt")?, b"hello secret");
        s.add("src/secret.txt", b"updated")?;
        s.add("empty", b"")?;
        assert_eq!(&*s.extract("empty")?, b"");
        let entry = &s.metadata.files["src/secret.txt"];
        let path = root.join("objects").join(format!("{}.enc", entry.object));
        let mut sealed: Sealed = serde_json::from_slice(&fs::read(&path)?)?;
        sealed.ciphertext.pop();
        fs::write(&path, serde_json::to_vec(&sealed)?)?;
        assert!(s.extract("src/secret.txt").is_err());
        s.remove("src/secret.txt")?;
        s.lock();
        let s = Session::unlock(&root, b"new-a", b"new-b")?;
        assert_eq!(s.list()?, vec![("empty", 0)]);
        assert!(Session::init(&root, b"a", b"b").is_err());
        Ok(())
    }
    #[test]
    fn metadata_tampering_and_object_binding() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("vault");
        let mut s = Session::init(&root, b"a", b"b")?;
        s.add("a", b"one")?;
        s.add("b", b"two")?;
        let a = root
            .join("objects")
            .join(format!("{}.enc", s.metadata.files["a"].object));
        let b = root
            .join("objects")
            .join(format!("{}.enc", s.metadata.files["b"].object));
        fs::copy(a, b)?;
        assert!(s.extract("b").is_err());
        s.lock();
        let path = root.join("metadata.enc");
        let mut sealed: Sealed = serde_json::from_slice(&fs::read(&path)?)?;
        sealed.ciphertext[0] ^= 1;
        fs::write(path, serde_json::to_vec(&sealed)?)?;
        assert!(Session::unlock(&root, b"a", b"b").is_err());
        Ok(())
    }
    #[test]
    fn failed_commit_locks_and_preserves_previous_metadata() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("vault");
        let mut s = Session::init(&root, b"a", b"b")?;
        s.add("kept", b"original")?;
        let meta = root.join("metadata.enc");
        let backup = root.join("metadata.backup");
        fs::rename(&meta, &backup)?;
        fs::create_dir(&meta)?; // Force atomic replacement to fail.
        assert!(s.add("uncommitted", b"new").is_err());
        assert!(s.list().is_err());
        fs::remove_dir(&meta)?;
        fs::rename(backup, meta)?;
        let s = Session::unlock(&root, b"a", b"b")?;
        assert_eq!(s.list()?, vec![("kept", 8)]);
        assert_eq!(&*s.extract("kept")?, b"original");
        Ok(())
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_objects() -> Result<()> {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("vault");
        let mut s = Session::init(&root, b"a", b"b")?;
        s.add("secret", b"secret")?;
        let object = root
            .join("objects")
            .join(format!("{}.enc", s.metadata.files["secret"].object));
        let outside = dir.path().join("outside");
        fs::rename(&object, &outside)?;
        symlink(outside, object)?;
        assert!(s.extract("secret").is_err());
        Ok(())
    }
}
