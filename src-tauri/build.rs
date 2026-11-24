use std::process::Command;

/// The embedded Python is a shared library that the loader must find when the
/// app starts. Record the folder it lives in as a runtime search path, using
/// the same interpreter PyO3 links against (PYO3_PYTHON, else python3).
fn embed_python_rpath() {
    println!("cargo:rerun-if-env-changed=PYO3_PYTHON");

    if cfg!(windows) {
        return;
    }

    let python = std::env::var("PYO3_PYTHON").unwrap_or_else(|_| "python3".to_string());

    let output = Command::new(&python)
        .args(["-c", "import sysconfig; print(sysconfig.get_config_var('LIBDIR') or '')"])
        .output();

    let Ok(output) = output else {
        println!("cargo:warning=could not ask {python} for its library folder");
        return;
    };

    let dir = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if dir.is_empty() {
        println!("cargo:warning={python} reported no library folder");
        return;
    }

    println!("cargo:rustc-link-arg=-Wl,-rpath,{dir}");
}

fn main() {
    embed_python_rpath();
    tauri_build::build()
}
