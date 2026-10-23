#![cfg(unix)]

use std::os::unix::{ffi::OsStrExt, fs::PermissionsExt};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn execute(command: &mut Command) -> Output {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("login PATH startup did not return within 8 seconds");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    child.wait_with_output().unwrap()
}

#[test]
fn startup_login_path_preserves_inherited_directories_and_bounds_shell_wait() {
    let scratch = tempfile::tempdir().unwrap();
    let inherited = scratch.path().join("inherited-bin");
    let login = scratch.path().join("login-bin");
    std::fs::create_dir(&inherited).unwrap();
    std::fs::create_dir(&login).unwrap();
    let tool = login.join("dsh-login-path-probe");
    std::fs::write(&tool, "#!/bin/sh\nprintf 'login-path-tool'\n").unwrap();
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o700)).unwrap();
    for (directory, marker) in [(&inherited, "inherited"), (&login, "login")] {
        let tool = directory.join("dsh-login-path-priority");
        std::fs::write(&tool, format!("#!/bin/sh\nprintf '{marker}'\n")).unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let shell = scratch.path().join("login-shell");
    std::fs::write(
        &shell,
        "#!/bin/sh\n[ \"$1\" = '-ilc' ] || exit 91\n[ \"$DISABLE_AUTO_UPDATE\" = true ] || exit 92\n[ \"$DSH_HOME\" = preserve-custom-home ] || exit 93\nprintf 'called' > \"$HOME/called\"\n[ \"$DSH_TEST_PATH_MODE\" != failed ] || exit 17\nif [ \"$DSH_TEST_PATH_MODE\" = hanging ]; then\n  /bin/sleep 60 &\n  echo \"$!\" > \"$HOME/descendant\"\n  wait\nfi\nexport PATH=\"$DSH_TEST_LOGIN_BIN:/usr/bin:/bin:$DSH_TEST_LOGIN_BIN\"\nexec /bin/sh -c \"$2\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
    let original = std::env::join_paths([
        inherited.as_path(),
        std::path::Path::new("/usr/bin"),
        std::path::Path::new("/bin"),
        inherited.as_path(),
    ])
    .unwrap();
    let expected = std::env::join_paths([
        login.as_path(),
        std::path::Path::new("/usr/bin"),
        std::path::Path::new("/bin"),
        inherited.as_path(),
    ])
    .unwrap();
    let configure = |executable: &std::path::Path, mode: &str| {
        let mut command = Command::new(executable);
        command
            .env("DSH_TEST_PATH_MODE", mode)
            .env("DSH_TEST_LOGIN_BIN", &login)
            .env("DSH_TEST_EXPECTED_PATH", &expected)
            .env(
                "SHELL",
                if mode == "missing" {
                    scratch.path().join("missing-shell")
                } else {
                    shell.clone()
                },
            )
            .env("PATH", &original)
            .env("HOME", scratch.path())
            .env("DSH_HOME", "preserve-custom-home")
            .env("DSH_E2E_HOME", "relative")
            .env("TAURI_WEBDRIVER_PORT", "4445")
            .env_remove("APPDIR");
        command
    };

    let binary = std::path::Path::new(env!("CARGO_BIN_EXE_deepseek-harness-desktop"));
    let non_utf8 = std::ffi::OsStr::from_bytes(b"\xff");
    let helper = execute(
        configure(binary, "restored")
            .arg("--print-login-path")
            .arg(non_utf8),
    );
    assert!(
        helper.status.success(),
        "{}",
        String::from_utf8_lossy(&helper.stderr)
    );
    assert_eq!(helper.stdout, expected.as_bytes());
    let output = Command::new("dsh-login-path-probe")
        .env("PATH", &expected)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"login-path-tool");
    for mode in ["restored", "failed", "missing", "hanging"] {
        let mut probe = configure(&std::env::current_exe().unwrap(), mode);
        let result = execute(probe.args(["--exact", "restored_path_child", "--nocapture"]));
        assert!(
            result.status.success(),
            "{mode}: {}\n{}",
            String::from_utf8_lossy(&result.stderr),
            String::from_utf8_lossy(&result.stdout)
        );
        if scratch.path().join("called").exists() {
            std::fs::remove_file(scratch.path().join("called")).unwrap();
        }
        let started = Instant::now();
        let output = execute(configure(binary, mode).arg(non_utf8));
        assert_eq!(output.status.code(), Some(1), "{mode}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("STARTUP_E2E_HOME_INVALID:"),
            "{mode}: {stderr}"
        );
        assert_eq!(
            stderr.contains("STARTUP_PATH_RESTORE_FAILED:"),
            mode != "restored",
            "{mode}: {stderr}"
        );
        assert_eq!(scratch.path().join("called").exists(), mode != "missing");
        if mode == "hanging" {
            assert!(stderr.contains("timed out after 3 seconds"), "{stderr}");
            assert!(started.elapsed() < Duration::from_secs(6));
            let pid: i32 = std::fs::read_to_string(scratch.path().join("descendant"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while unsafe { libc::kill(pid, 0) } == 0 {
                let status = Command::new("/bin/ps")
                    .args(["-o", "stat=", "-p", &pid.to_string()])
                    .output()
                    .unwrap();
                if String::from_utf8_lossy(&status.stdout)
                    .trim()
                    .starts_with('Z')
                {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "login shell descendant {pid} survived timeout"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    assert!(!scratch.path().join("app-data").exists());
}

#[test]
fn restored_path_child() {
    let Ok(mode) = std::env::var("DSH_TEST_PATH_MODE") else {
        return;
    };
    let original = std::env::var_os("PATH").unwrap();
    let result = main::desktop::login_path::restore(std::path::Path::new(env!(
        "CARGO_BIN_EXE_deepseek-harness-desktop"
    )));
    assert_eq!(result.is_ok(), mode == "restored", "{mode}: {result:?}");
    let expected = if mode == "restored" {
        std::env::var_os("DSH_TEST_EXPECTED_PATH").unwrap()
    } else {
        original
    };
    assert_eq!(std::env::var_os("PATH").unwrap(), expected);
    assert_eq!(std::env::var("DSH_HOME").unwrap(), "preserve-custom-home");
    let tool = Command::new("dsh-login-path-probe").output();
    if mode == "restored" {
        assert_eq!(tool.unwrap().stdout, b"login-path-tool");
    } else {
        assert_eq!(tool.unwrap_err().kind(), std::io::ErrorKind::NotFound);
    }
    let priority = Command::new("dsh-login-path-priority").output().unwrap();
    assert!(priority.status.success());
    assert_eq!(
        priority.stdout,
        if mode == "restored" {
            b"login".as_slice()
        } else {
            b"inherited".as_slice()
        }
    );
}
