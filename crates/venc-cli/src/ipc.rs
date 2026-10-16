use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::Path,
};
use venc_vault::{FsError, Session, MAX_FILE_SIZE};
use zeroize::{Zeroize, Zeroizing};

const MAX_FRAME: usize = 24 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u64,
    method: String,
    params: Value,
}
fn scrub(value: &mut Value) {
    match value {
        Value::String(s) => s.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(scrub),
        Value::Object(values) => values.values_mut().for_each(scrub),
        _ => (),
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        scrub(&mut self.params);
    }
}
fn text<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .context("invalid request parameters")
}
fn flag(params: &Value, key: &str) -> Result<bool> {
    params
        .get(key)
        .and_then(Value::as_bool)
        .context("invalid request parameters")
}
fn dispatch(request: &Request, session: &mut Option<Session>) -> Result<Value> {
    let p = &request.params;
    match request.method.as_str() {
        "hello" => {
            return Ok(
                json!({"protocol":1,"capabilities":["changePasswords","protectedEditor","draftRecovery"]}),
            )
        }
        "init" | "unlock" => {
            ensure!(session.is_none(), "session is already open");
            let path = Path::new(text(p, "vault")?);
            let a = text(p, "passwordA")?.as_bytes();
            let b = text(p, "passwordB")?.as_bytes();
            let opened = if request.method == "init" {
                Session::init(path, a, b)?
            } else {
                Session::unlock(path, a, b)?
            };
            let result = json!({ "vaultId": opened.vault_id(), "protocol": 1, "capabilities": ["changePasswords","protectedEditor","draftRecovery"] });
            *session = Some(opened);
            return Ok(result);
        }
        "lock" => {
            *session = None;
            return Ok(Value::Null);
        }
        _ => (),
    }
    let s = session.as_mut().ok_or(FsError::Unavailable)?;
    Ok(match request.method.as_str() {
        "changePasswords" => {
            s.change_passwords(
                text(p, "oldA")?.as_bytes(),
                text(p, "oldB")?.as_bytes(),
                text(p, "newA")?.as_bytes(),
                text(p, "newB")?.as_bytes(),
            )?;
            Value::Null
        }
        "stat" => serde_json::to_value(s.stat(text(p, "path")?)?)?,
        "readDirectory" => serde_json::to_value(s.read_directory(text(p, "path")?)?)?,
        "readFile" => {
            let plain = s.read_file(text(p, "path")?)?;
            json!({ "data": STANDARD.encode(&*plain) })
        }
        "readDocument" | "readBackup" => {
            let snapshot = if request.method == "readDocument" {
                s.read_document(text(p, "path")?)?
            } else {
                s.read_backup(text(p, "backup")?, text(p, "path")?)?
            };
            json!({"data": STANDARD.encode(&*snapshot.data), "revision": snapshot.revision})
        }
        "writeDocument" | "createBackup" => {
            let encoded = text(p, "data")?;
            ensure!(
                encoded.len() <= MAX_FILE_SIZE.div_ceil(3) * 4,
                "file exceeds size limit"
            );
            let plain = Zeroizing::new(STANDARD.decode(encoded)?);
            if request.method == "writeDocument" {
                json!({"revision": s.write_document(text(p, "path")?, text(p, "revision")?, &plain)?})
            } else {
                json!({"backup": s.create_backup(text(p, "path")?, text(p, "revision")?, &plain)?})
            }
        }
        "listBackups" => serde_json::to_value(s.list_backups(text(p, "after")?)?)?,
        "recoverBackup" => {
            s.recover_backup(text(p, "backup")?, text(p, "path")?)?;
            Value::Null
        }
        "deleteBackup" => {
            s.delete_backup(text(p, "backup")?)?;
            Value::Null
        }
        "writeFile" => {
            let encoded = text(p, "data")?;
            ensure!(
                encoded.len() <= MAX_FILE_SIZE.div_ceil(3) * 4,
                "file exceeds size limit"
            );
            let plain = Zeroizing::new(STANDARD.decode(encoded)?);
            s.write_file(
                text(p, "path")?,
                &plain,
                flag(p, "create")?,
                flag(p, "overwrite")?,
            )?;
            Value::Null
        }
        "createDirectory" => {
            s.create_directory(text(p, "path")?)?;
            Value::Null
        }
        "delete" => {
            s.delete(text(p, "path")?, flag(p, "recursive")?)?;
            Value::Null
        }
        "rename" => {
            s.rename(
                text(p, "source")?,
                text(p, "target")?,
                flag(p, "overwrite")?,
            )?;
            Value::Null
        }
        _ => anyhow::bail!("unknown method"),
    })
}
fn error_code(err: &anyhow::Error) -> &'static str {
    match err.downcast_ref::<FsError>() {
        Some(FsError::NotFound) => "FileNotFound",
        Some(FsError::Exists) => "FileExists",
        Some(FsError::NotDirectory) => "FileNotADirectory",
        Some(FsError::IsDirectory) => "FileIsADirectory",
        Some(FsError::NoPermissions) => "NoPermissions",
        _ => "Unavailable",
    }
}
// Bound frames before parsing; never expose request bodies in diagnostic logs.
fn frame(input: &mut impl BufRead) -> Result<Zeroizing<Vec<u8>>> {
    let mut bytes = Zeroizing::new(Vec::new());
    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            break;
        }
        let end = available.iter().position(|b| *b == b'\n').map(|i| i + 1);
        let count = end.unwrap_or(available.len());
        ensure!(bytes.len() + count <= MAX_FRAME, "IPC frame exceeds limit");
        bytes.extend_from_slice(&available[..count]);
        input.consume(count);
        if end.is_some() {
            break;
        }
    }
    Ok(bytes)
}
pub fn serve(mut input: impl BufRead, mut output: impl Write) -> Result<()> {
    let mut session = None;
    loop {
        let bytes = frame(&mut input)?;
        if bytes.is_empty() {
            break;
        }
        let request: Request = match serde_json::from_slice(&bytes) {
            Ok(request) => request,
            Err(_) => anyhow::bail!("invalid IPC frame"),
        };
        let result = dispatch(&request, &mut session);
        let locked = session.as_ref().is_none_or(Session::is_locked);
        if locked {
            session = None;
        }
        let mut response = match result {
            Ok(result) => json!({ "id": request.id, "result": result, "locked": locked }),
            Err(err) => {
                json!({ "id": request.id, "error": { "code": error_code(&err), "message": err.to_string() }, "locked": locked })
            }
        };
        let encoded = Zeroizing::new(serde_json::to_vec(&response)?);
        scrub(&mut response);
        output.write_all(&encoded)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(()) // EOF drops the Session and erases its keys.
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ipc_roundtrip_and_lock() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let vault = temp.path().join("vault");
        let requests = [
            json!({"id":1,"method":"init","params":{"vault":vault,"passwordA":"a","passwordB":"b"}}),
            json!({"id":2,"method":"createDirectory","params":{"path":"dir"}}),
            json!({"id":3,"method":"writeFile","params":{"path":"dir/a","data":"AAH/","create":true,"overwrite":false}}),
            json!({"id":4,"method":"readFile","params":{"path":"dir/a"}}),
            json!({"id":5,"method":"rename","params":{"source":"dir","target":"moved","overwrite":false}}),
            json!({"id":6,"method":"stat","params":{"path":"moved/a"}}),
            json!({"id":7,"method":"lock","params":{}}),
            json!({"id":8,"method":"readFile","params":{"path":"moved/a"}}),
        ];
        let input = requests
            .iter()
            .map(|r| format!("{r}\n"))
            .collect::<String>();
        let mut output = Vec::new();
        serve(input.as_bytes(), &mut output)?;
        let responses: Vec<Value> = String::from_utf8(output)?
            .lines()
            .map(serde_json::from_str)
            .collect::<std::result::Result<_, _>>()?;
        assert_eq!(responses[3]["result"]["data"], "AAH/");
        assert_eq!(responses[5]["result"]["size"], 3);
        assert_eq!(responses[7]["error"]["code"], "Unavailable");
        assert_eq!(responses[7]["locked"], true);
        let s = Session::unlock(&vault, b"a", b"b")?;
        assert_eq!(&*s.read_file("moved/a")?, &[0, 1, 255]);
        Ok(())
    }
    #[test]
    fn malformed_requests_do_not_echo_secrets() {
        let mut out = Vec::new();
        let result = serve(b"{\"passwordA\":\"secret\"}\n".as_slice(), &mut out);
        assert!(result.is_err());
        assert!(!result.unwrap_err().to_string().contains("secret"));
        assert!(out.is_empty());
    }
    #[test]
    fn ipc_password_change_reauthenticates_and_keeps_objects() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let vault = temp.path().join("vault");
        let mut session = Some(Session::init(&vault, b"a", b"b")?);
        session
            .as_mut()
            .unwrap()
            .write_file("file", b"secret", true, false)?;
        let before = std::fs::read(vault.join("metadata.enc"))?;
        let request = |old_a: &str| Request {
            id: 1,
            method: "changePasswords".into(),
            params: json!({"oldA":old_a,"oldB":"b","newA":"new-a","newB":"new-b"}),
        };
        assert!(dispatch(&request("wrong"), &mut session).is_err());
        dispatch(&request("a"), &mut session)?;
        assert_eq!(std::fs::read(vault.join("metadata.enc"))?, before);
        session = None;
        assert!(session.is_none());
        assert!(Session::unlock(&vault, b"a", b"b").is_err());
        let opened = Session::unlock(&vault, b"new-a", b"new-b")?;
        assert_eq!(&*opened.read_file("file")?, b"secret");
        Ok(())
    }
}
