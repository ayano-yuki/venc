//! Custom editor snapshots and encrypted crash drafts. No plaintext disk staging.
use super::*;

pub struct DocumentSnapshot {
    pub revision: String,
    pub data: Zeroizing<Vec<u8>>,
}
#[derive(Serialize)]
pub struct BackupInfo {
    pub id: String,
    pub path: String,
    pub size: usize,
    pub modified: u64,
}
#[derive(Serialize)]
pub struct BackupPage {
    pub entries: Vec<BackupInfo>,
    pub next: Option<String>,
    pub invalid: usize,
}
const MAX_DRAFT: usize = 4 + 4096 + 32 + MAX_FILE_SIZE;
impl Session {
    pub fn read_document(&self, path: &str) -> Result<DocumentSnapshot> {
        let data = self.read_file(path)?;
        Ok(DocumentSnapshot {
            revision: self
                .metadata
                .files
                .get(path)
                .ok_or(FsError::NotFound)?
                .object
                .clone(),
            data,
        })
    }
    pub fn write_document(&mut self, path: &str, revision: &str, data: &[u8]) -> Result<String> {
        self.master()?;
        valid_path(path)?;
        ensure!(valid_id(revision), "invalid document revision");
        let current = self.metadata.files.get(path).ok_or(FsError::NotFound)?;
        ensure!(
            current.object == revision,
            "document changed; reopen or revert before saving"
        );
        self.write_file(path, data, false, true)?;
        Ok(self
            .metadata
            .files
            .get(path)
            .ok_or(FsError::NotFound)?
            .object
            .clone())
    }
    fn draft_path(&self, backup: &str) -> Result<PathBuf> {
        self.master()?;
        ensure!(valid_id(backup), "invalid backup identifier");
        let objects = self.root.join("objects");
        ensure!(
            fs::symlink_metadata(&objects)?.is_dir(),
            "invalid objects directory"
        );
        Ok(objects.join(format!(".backup.{backup}.enc")))
    }
    fn draft_key(&self) -> Result<Key> {
        expand(
            &self.master()?[..],
            self.header.vault_id.as_bytes(),
            b"venc/v1/editor-backup",
        )
    }
    pub fn create_backup(&self, path: &str, revision: &str, data: &[u8]) -> Result<String> {
        self.master()?;
        valid_path(path)?;
        ensure!(valid_id(revision), "invalid document revision");
        ensure!(data.len() <= MAX_FILE_SIZE, "file exceeds 16 MiB limit");
        let mut plain = Zeroizing::new(Vec::with_capacity(4 + path.len() + 32 + data.len()));
        plain.extend_from_slice(&(path.len() as u32).to_be_bytes());
        plain.extend_from_slice(path.as_bytes());
        plain.extend_from_slice(revision.as_bytes());
        plain.extend_from_slice(data);
        let backup = id()?;
        let destination = self.draft_path(&backup)?;
        let sealed = seal(
            &self.draft_key()?,
            &plain,
            &aad(&self.header.vault_id, "editor-backup", &backup),
        )?;
        let mut file = options().open(&destination)?;
        file.write_all(&serde_json::to_vec(&sealed)?)?;
        file.sync_all()?;
        sync_dir(destination.parent().context("missing backup directory")?)?;
        Ok(backup)
    }
    fn decode_backup(&self, backup: &str) -> Result<(Zeroizing<String>, DocumentSnapshot)> {
        let sealed: Sealed =
            serde_json::from_slice(&read_bounded(&self.draft_path(backup)?, MAX_JSON)?)?;
        ensure!(
            sealed.ciphertext.len() <= MAX_DRAFT + 16,
            "backup exceeds size limit"
        );
        let plain = open(
            &self.draft_key()?,
            &sealed,
            &aad(&self.header.vault_id, "editor-backup", backup),
        )?;
        ensure!(plain.len() >= 4 + 1 + 32, "invalid backup length");
        let length = u32::from_be_bytes(plain[..4].try_into()?) as usize;
        ensure!(
            (1..=4096).contains(&length) && 4 + length + 32 <= plain.len(),
            "invalid backup path length"
        );
        let path = Zeroizing::new(std::str::from_utf8(&plain[4..4 + length])?.to_owned());
        valid_path(&path)?;
        let revision = std::str::from_utf8(&plain[4 + length..4 + length + 32])?;
        ensure!(valid_id(revision), "invalid backup revision");
        let data = &plain[4 + length + 32..];
        ensure!(data.len() <= MAX_FILE_SIZE, "file exceeds 16 MiB limit");
        Ok((
            path,
            DocumentSnapshot {
                revision: revision.into(),
                data: Zeroizing::new(data.to_vec()),
            },
        ))
    }
    pub fn read_backup(&self, backup: &str, path: &str) -> Result<DocumentSnapshot> {
        valid_path(path)?;
        let (original, snapshot) = self.decode_backup(backup)?;
        ensure!(*original == path, "backup belongs to another document");
        Ok(snapshot)
    }
    pub fn list_backups(&self, after: &str) -> Result<BackupPage> {
        self.master()?;
        ensure!(after.is_empty() || valid_id(after), "invalid backup cursor");
        let objects = self
            .draft_path(&"0".repeat(32))?
            .parent()
            .context("missing directory")?
            .to_owned();
        let mut candidates = std::collections::BTreeSet::new();
        for entry in fs::read_dir(objects)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(backup) = name
                .strip_prefix(".backup.")
                .and_then(|n| n.strip_suffix(".enc"))
            else {
                continue;
            };
            if valid_id(backup) && backup > after {
                candidates.insert(backup.to_owned());
                if candidates.len() > 21 {
                    candidates.pop_last();
                }
            }
        }
        let next = if candidates.len() > 20 {
            candidates.iter().nth(19).cloned()
        } else {
            None
        };
        let mut entries = Vec::new();
        let mut invalid = 0;
        for backup in candidates.into_iter().take(20) {
            match self.decode_backup(&backup) {
                Ok((path, snapshot)) => {
                    let modified = fs::symlink_metadata(self.draft_path(&backup)?)?
                        .modified()?
                        .duration_since(std::time::UNIX_EPOCH)?
                        .as_millis() as u64;
                    entries.push(BackupInfo {
                        id: backup,
                        path: path.to_string(),
                        size: snapshot.data.len(),
                        modified,
                    });
                }
                Err(_) => invalid += 1,
            }
        }
        Ok(BackupPage {
            entries,
            next,
            invalid,
        })
    }
    pub fn recover_backup(&mut self, backup: &str, target: &str) -> Result<()> {
        valid_path(target)?;
        let (_, snapshot) = self.decode_backup(backup)?;
        // Recovery never replaces a newer file, even when the original was renamed or removed.
        if let Some((parent, _)) = target.rsplit_once('/') {
            self.create_directory(parent)?;
        }
        self.write_file(target, &snapshot.data, true, false)
    }
    pub fn delete_backup(&self, backup: &str) -> Result<()> {
        let location = self.draft_path(backup)?;
        match fs::symlink_metadata(&location) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            other => ensure!(other?.is_file(), "expected a regular backup file"),
        }
        fs::remove_file(&location)?;
        sync_dir(location.parent().context("missing backup directory")?)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drafts_authenticate_path_identity_revision_and_survive_reunlock() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().join("vault");
        let mut session = Session::init(&root, b"a", b"b")?;
        session.write_file("note", b"saved", true, false)?;
        let old = session.read_document("note")?;
        let backup = session.create_backup("note", &old.revision, b"secret unsaved content")?;
        let draft_path = session.draft_path(&backup)?;
        assert!(!fs::read(&draft_path)?.windows(6).any(|p| p == b"secret"));
        assert!(session.read_backup(&backup, "other").is_err());
        assert!(session.read_backup("../note", "note").is_err());
        let swapped = id()?;
        fs::copy(&draft_path, session.draft_path(&swapped)?)?;
        assert!(session.read_backup(&swapped, "note").is_err());
        session.change_passwords(b"a", b"b", b"c", b"d")?;
        session.lock();
        assert!(session.read_backup(&backup, "note").is_err());
        drop(session);
        let mut session = Session::unlock(&root, b"c", b"d")?;
        let recovered = session.read_backup(&backup, "note")?;
        assert_eq!(&*recovered.data, b"secret unsaved content");
        let page = session.list_backups("")?;
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.invalid, 1); // authenticated ID swapping was rejected
        assert_eq!(page.entries[0].path, "note");
        session.write_document("note", &old.revision, b"new saved")?;
        session.recover_backup(&backup, "Recovered/note")?;
        assert_eq!(
            &*session.read_file("Recovered/note")?,
            b"secret unsaved content"
        );
        assert!(session.recover_backup(&backup, "note").is_err());
        assert!(session
            .write_document("note", &recovered.revision, &recovered.data)
            .is_err());
        assert_eq!(&*session.read_file("note")?, b"new saved");
        let mut sealed: Sealed = serde_json::from_slice(&fs::read(&draft_path)?)?;
        sealed.ciphertext[0] ^= 1;
        fs::write(&draft_path, serde_json::to_vec(&sealed)?)?;
        assert!(session.read_backup(&backup, "note").is_err());
        session.delete_backup(&backup)?;
        session.delete_backup(&backup)?;
        assert!(!draft_path.exists());
        Ok(())
    }
}
