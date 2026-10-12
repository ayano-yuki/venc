use super::*;
use std::{
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsError {
    NotFound,
    Exists,
    NotDirectory,
    IsDirectory,
    NoPermissions,
    Unavailable,
}
impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NotFound => "file not found",
            Self::Exists => "file exists",
            Self::NotDirectory => "not a directory",
            Self::IsDirectory => "is a directory",
            Self::NoPermissions => "operation is not permitted",
            Self::Unavailable => "vault is unavailable",
        })
    }
}
impl std::error::Error for FsError {}
#[derive(Serialize)]
pub struct Stat {
    pub kind: &'static str,
    pub size: usize,
    pub ctime: u64,
    pub mtime: u64,
}
pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}
fn within(path: &str, root: &str) -> bool {
    root.is_empty() || path == root || path.starts_with(&format!("{root}/"))
}
impl Session {
    pub(super) fn is_directory(&self, path: &str) -> bool {
        path.is_empty()
            || self.metadata.directories.contains_key(path)
            || self
                .metadata
                .files
                .keys()
                .chain(self.metadata.directories.keys())
                .any(|p| p.starts_with(&format!("{path}/")))
    }
    fn fs_ready(&self, path: &str) -> Result<()> {
        self.master().map_err(|_| FsError::Unavailable)?;
        if !path.is_empty() {
            valid_path(path).map_err(|_| FsError::NoPermissions)?;
        }
        Ok(())
    }
    pub fn stat(&self, path: &str) -> Result<Stat> {
        self.fs_ready(path)?;
        if let Some(entry) = self.metadata.files.get(path) {
            return Ok(Stat {
                kind: "file",
                size: entry.size,
                ctime: entry.ctime,
                mtime: entry.mtime,
            });
        }
        if self.is_directory(path) {
            let stamp = self.metadata.directories.get(path).copied().unwrap_or(0);
            return Ok(Stat {
                kind: "directory",
                size: 0,
                ctime: stamp,
                mtime: stamp,
            });
        }
        Err(FsError::NotFound.into())
    }
    pub fn read_directory(&self, path: &str) -> Result<Vec<(String, &'static str)>> {
        let stat = self.stat(path)?;
        if stat.kind != "directory" {
            return Err(FsError::NotDirectory.into());
        }
        let prefix = if path.is_empty() {
            String::new()
        } else {
            format!("{path}/")
        };
        let mut entries = BTreeMap::new();
        for p in self
            .metadata
            .files
            .keys()
            .chain(self.metadata.directories.keys())
        {
            if let Some(relative) = p.strip_prefix(&prefix) {
                if relative.is_empty() {
                    continue;
                }
                let name = relative.split('/').next().unwrap();
                let kind = if relative.contains('/') || self.metadata.directories.contains_key(p) {
                    "directory"
                } else {
                    "file"
                };
                entries.insert(name.to_owned(), kind);
            }
        }
        Ok(entries.into_iter().collect())
    }
    pub fn create_directory(&mut self, path: &str) -> Result<()> {
        self.fs_ready(path)?;
        if self.is_directory(path) {
            return Ok(());
        }
        let mut metadata = self.metadata.clone();
        let mut current = String::new();
        for component in path.split('/').filter(|s| !s.is_empty()) {
            if !current.is_empty() {
                current.push('/');
            }
            current.push_str(component);
            if metadata.files.contains_key(&current) {
                return Err(if current == path {
                    FsError::Exists
                } else {
                    FsError::NotDirectory
                }
                .into());
            }
            metadata
                .directories
                .entry(current.clone())
                .or_insert_with(now);
        }
        self.commit(metadata)
    }
    pub fn write_file(
        &mut self,
        path: &str,
        plain: &[u8],
        create: bool,
        overwrite: bool,
    ) -> Result<()> {
        self.fs_ready(path)?;
        if self.is_directory(path) {
            return Err(FsError::IsDirectory.into());
        }
        let exists = self.metadata.files.contains_key(path);
        if exists && !overwrite {
            return Err(FsError::Exists.into());
        }
        if !exists && !create {
            return Err(FsError::NotFound.into());
        }
        match self.stat(parent(path)) {
            Ok(stat) if stat.kind == "directory" => (),
            Ok(_) => return Err(FsError::NotDirectory.into()),
            Err(err) => return Err(err),
        }
        // Retain implicit directories from CLI-created files when their last file is moved or deleted.
        self.add(path, plain)
    }
    pub fn read_file(&self, path: &str) -> Result<Zeroizing<Vec<u8>>> {
        if self.stat(path)?.kind != "file" {
            return Err(FsError::IsDirectory.into());
        }
        self.extract(path)
    }
    fn materialize_directories(&self, metadata: &mut Metadata) {
        let paths: Vec<String> = metadata
            .files
            .keys()
            .chain(metadata.directories.keys())
            .cloned()
            .collect();
        for path in paths {
            let mut ancestor = parent(&path);
            while !ancestor.is_empty() {
                metadata
                    .directories
                    .entry(ancestor.to_owned())
                    .or_insert_with(now);
                ancestor = parent(ancestor);
            }
        }
    }
    pub fn delete(&mut self, path: &str, recursive: bool) -> Result<()> {
        self.stat(path)?;
        if path.is_empty() {
            return Err(FsError::NoPermissions.into());
        }
        if self.is_directory(path) && !recursive && !self.read_directory(path)?.is_empty() {
            return Err(FsError::NoPermissions.into());
        }
        let mut metadata = self.metadata.clone();
        self.materialize_directories(&mut metadata);
        metadata.files.retain(|p, _| !within(p, path));
        metadata.directories.retain(|p, _| !within(p, path));
        self.commit(metadata)
    }
    pub fn rename(&mut self, source: &str, target: &str, overwrite: bool) -> Result<()> {
        let source_stat = self.stat(source)?;
        self.fs_ready(target)?;
        if source.is_empty() || target.is_empty() {
            return Err(FsError::NoPermissions.into());
        }
        if source == target {
            return Ok(());
        }
        if within(target, source) || within(source, target) {
            return Err(FsError::NoPermissions.into());
        }
        match self.stat(parent(target)) {
            Ok(stat) if stat.kind == "directory" => (),
            Ok(_) => return Err(FsError::NotDirectory.into()),
            Err(err) => return Err(err),
        }
        if let Ok(target_stat) = self.stat(target) {
            if !overwrite {
                return Err(FsError::Exists.into());
            }
            if target_stat.kind != source_stat.kind {
                return Err(FsError::NoPermissions.into());
            }
            if target_stat.kind == "directory" && !self.read_directory(target)?.is_empty() {
                return Err(FsError::NoPermissions.into());
            }
        }
        let mut metadata = self.metadata.clone();
        self.materialize_directories(&mut metadata);
        let map_path = |p: &str| -> String {
            if within(p, source) {
                format!("{target}{}", &p[source.len()..])
            } else {
                p.to_owned()
            }
        };
        metadata.files = metadata
            .files
            .iter()
            .filter(|(p, _)| !within(p, target))
            .map(|(p, e)| (map_path(p), e.clone()))
            .collect();
        metadata.directories = metadata
            .directories
            .iter()
            .filter(|(p, _)| !within(p, target))
            .map(|(p, t)| (map_path(p), *t))
            .collect();
        self.commit(metadata)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn code(result: Result<impl Sized>) -> FsError {
        *result.err().unwrap().downcast_ref::<FsError>().unwrap()
    }
    #[test]
    fn virtual_filesystem_contract_and_persistence() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().join("vault");
        let mut s = Session::init(&root, b"a", b"b")?;
        assert_eq!(s.stat("")?.kind, "directory");
        s.create_directory("dir/nested")?;
        s.create_directory("empty")?;
        assert_eq!(
            code(s.write_file("missing/a", b"a", true, true)),
            FsError::NotFound
        );
        assert_eq!(
            code(s.write_file("a", b"a", false, true)),
            FsError::NotFound
        );
        s.write_file("dir/nested/a.txt", b"first", true, false)?;
        assert_eq!(
            code(s.write_file("dir/nested/a.txt", b"wrong", true, false)),
            FsError::Exists
        );
        let before = s.stat("dir/nested/a.txt")?;
        s.write_file("dir/nested/a.txt", b"second", false, true)?;
        let after = s.stat("dir/nested/a.txt")?;
        assert!(after.mtime > before.mtime);
        assert_eq!(after.ctime, before.ctime);
        assert_eq!(
            code(s.create_directory("dir/nested/a.txt")),
            FsError::Exists
        );
        assert_eq!(
            code(s.write_file("dir", b"a", true, true)),
            FsError::IsDirectory
        );
        assert_eq!(
            code(s.read_directory("dir/nested/a.txt")),
            FsError::NotDirectory
        );
        assert_eq!(
            s.read_directory("dir")?,
            vec![("nested".into(), "directory")]
        );
        assert_eq!(code(s.delete("dir", false)), FsError::NoPermissions);
        assert_eq!(
            code(s.rename("dir", "dir/nested/new", false)),
            FsError::NoPermissions
        );
        let object = s.metadata.files["dir/nested/a.txt"].object.clone();
        s.rename("dir", "renamed", false)?;
        assert_eq!(s.metadata.files["renamed/nested/a.txt"].object, object);
        assert_eq!(&*s.read_file("renamed/nested/a.txt")?, b"second");
        s.write_file("target", b"old", true, false)?;
        assert_eq!(
            code(s.rename("renamed/nested/a.txt", "target", false)),
            FsError::Exists
        );
        s.rename("renamed/nested/a.txt", "target", true)?;
        assert_eq!(&*s.read_file("target")?, b"second");
        s.lock();
        assert_eq!(code(s.stat("")), FsError::Unavailable);
        let mut s = Session::unlock(&root, b"a", b"b")?;
        assert_eq!(s.stat("empty")?.kind, "directory");
        assert_eq!(s.stat("renamed/nested")?.kind, "directory");
        s.delete("renamed", true)?;
        assert_eq!(code(s.stat("renamed")), FsError::NotFound);
        assert_eq!(code(s.delete("", true)), FsError::NoPermissions);
        assert_eq!(
            code(s.create_directory("../escape")),
            FsError::NoPermissions
        );
        assert_eq!(&*s.read_file("target")?, b"second");
        Ok(())
    }
}
