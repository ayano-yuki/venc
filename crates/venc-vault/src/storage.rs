//! Reclaim only durable, unreferenced immutable objects. Drafts and unknown files are never GC targets.
use super::*;
use std::{
    collections::BTreeSet,
    time::{Duration, SystemTime},
};
const RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
#[derive(Default, Serialize)]
pub struct StorageInfo {
    pub total_bytes: u64,
    pub live_bytes: u64,
    pub backup_bytes: u64,
    pub reclaimable_bytes: u64,
    pub recent_retired_bytes: u64,
    pub unknown_bytes: u64,
    pub reclaimable_files: u64,
    pub missing_live_files: u64,
}
#[derive(Serialize)]
pub struct Collection {
    pub removed_files: u64,
    pub removed_bytes: u64,
    pub remaining: StorageInfo,
}
impl Session {
    fn scan_storage(&self) -> Result<(StorageInfo, Vec<PathBuf>)> {
        self.master()?;
        let objects = self.root.join("objects");
        ensure!(
            fs::symlink_metadata(&objects)?.is_dir(),
            "invalid objects directory"
        );
        let referenced: BTreeSet<_> = self
            .metadata
            .files
            .values()
            .map(|e| e.object.as_str())
            .collect();
        let mut found = BTreeSet::new();
        let mut info = StorageInfo::default();
        let mut eligible = Vec::new();
        for entry in fs::read_dir(&objects)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.is_file() {
                continue;
            }
            let size = metadata.len();
            info.total_bytes += size;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(id) = name.strip_suffix(".enc").filter(|id| valid_id(id)) {
                if referenced.contains(id) {
                    info.live_bytes += size;
                    found.insert(id.to_owned());
                } else if SystemTime::now()
                    .duration_since(metadata.modified()?)
                    .unwrap_or_default()
                    >= RETENTION
                {
                    info.reclaimable_bytes += size;
                    info.reclaimable_files += 1;
                    if eligible.len() < 1000 {
                        eligible.push(entry.path());
                    }
                } else {
                    info.recent_retired_bytes += size;
                }
            } else if name
                .strip_prefix(".backup.")
                .and_then(|n| n.strip_suffix(".enc"))
                .is_some_and(valid_id)
            {
                info.backup_bytes += size;
            } else {
                info.unknown_bytes += size;
            }
        }
        info.missing_live_files = referenced.len().saturating_sub(found.len()) as u64;
        for name in ["vault.json", "metadata.enc", ".session.lock"] {
            let metadata = fs::symlink_metadata(self.root.join(name))?;
            ensure!(metadata.is_file(), "invalid vault control file");
            info.total_bytes += metadata.len();
        }
        Ok((info, eligible))
    }
    pub fn storage_info(&self) -> Result<StorageInfo> {
        Ok(self.scan_storage()?.0)
    }
    fn assert_gc_state(&self) -> Result<()> {
        let header: Header =
            serde_json::from_slice(&read_bounded(&self.root.join("vault.json"), 16 * 1024)?)?;
        ensure!(
            serde_json::to_vec(&header)? == serde_json::to_vec(&self.header)?,
            "vault header changed outside the session"
        );
        let sealed: Sealed =
            serde_json::from_slice(&read_bounded(&self.root.join("metadata.enc"), MAX_JSON)?)?;
        ensure!(
            sealed.ciphertext.len() <= MAX_METADATA + 16,
            "invalid metadata length"
        );
        let key = expand(
            &self.master()?[..],
            self.header.vault_id.as_bytes(),
            b"venc/v1/metadata",
        )?;
        let plaintext = open(&key, &sealed, &aad(&self.header.vault_id, "metadata", ""))?;
        let disk: Metadata = serde_json::from_slice(&plaintext)?;
        let canonical = Zeroizing::new(serde_json::to_vec(&disk)?);
        let memory = Zeroizing::new(serde_json::to_vec(&self.metadata)?);
        ensure!(
            *canonical == *memory,
            "vault metadata changed outside the session"
        );
        // Make the references durable before any unlink, including after a prior uncertain sync.
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(self.root.join("vault.json"))?
            .sync_all()?;
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(self.root.join("metadata.enc"))?
            .sync_all()?;
        sync_dir(&self.root)?;
        Ok(())
    }
    pub fn collect_garbage(&mut self) -> Result<Collection> {
        self.master()?;
        if let Err(error) = self.assert_gc_state() {
            self.lock();
            return Err(error.context("cleanup refused; unlock the vault again"));
        }
        let (info, eligible) = self.scan_storage()?;
        ensure!(
            info.missing_live_files == 0,
            "cleanup refused: current objects are missing; restore a complete backup first"
        );
        let mut removed_files = 0;
        let mut removed_bytes = 0;
        for object in eligible {
            let metadata = fs::symlink_metadata(&object)?;
            ensure!(
                metadata.is_file(),
                "cleanup target is no longer a regular file"
            );
            if SystemTime::now()
                .duration_since(metadata.modified()?)
                .unwrap_or_default()
                < RETENTION
            {
                continue;
            }
            fs::remove_file(object)?;
            removed_files += 1;
            removed_bytes += metadata.len();
        }
        sync_dir(&self.root.join("objects"))?;
        Ok(Collection {
            removed_files,
            removed_bytes,
            remaining: self.storage_info()?,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn collection_keeps_live_recent_drafts_unknown_and_refuses_changed_metadata() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().join("vault");
        let mut session = Session::init(&root, b"a", b"b")?;
        session.write_file("note", b"old", true, false)?;
        let old = session.read_document("note")?;
        let old_object = root.join("objects").join(format!("{}.enc", old.revision));
        let backup = session.create_backup("note", &old.revision, b"draft")?;
        session.write_document("note", &old.revision, b"current")?;
        assert_eq!(session.storage_info()?.reclaimable_files, 0);
        File::open(&old_object)?.set_times(
            std::fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1)),
        )?;
        fs::write(root.join("objects/unknown"), b"keep")?;
        assert_eq!(session.storage_info()?.reclaimable_files, 1);
        let collection = session.collect_garbage()?;
        assert_eq!(collection.removed_files, 1);
        assert!(!old_object.exists());
        assert_eq!(&*session.read_file("note")?, b"current");
        assert_eq!(&*session.read_backup(&backup, "note")?.data, b"draft");
        assert!(root.join("objects/unknown").exists());
        fs::write(root.join("metadata.enc"), b"damaged")?;
        assert!(session.collect_garbage().is_err());
        assert!(session.is_locked());
        Ok(())
    }
}
