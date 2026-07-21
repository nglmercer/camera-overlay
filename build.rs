use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn collect_files(root: &Path, current: &Path, files: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(current).expect("failed to read static asset directory");
    for entry in entries {
        let path = entry.expect("failed to read static asset entry").path();
        if path.is_dir() {
            collect_files(root, &path, files);
        } else {
            files.push(path.strip_prefix(root).expect("asset path is outside static").to_path_buf());
        }
    }
}

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("missing manifest dir"));
    let static_dir = manifest_dir.join("static");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("missing OUT_DIR"));
    let generated_path = out_dir.join("embedded_assets.rs");

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=static");

    let mut files = Vec::new();
    collect_files(&static_dir, &static_dir, &mut files);
    files.sort();

    let mut generated = String::from(
        "pub fn get(path: &str) -> Option<&'static [u8]> {\n    match path {\n",
    );

    for relative_path in files {
        let key = relative_path.to_string_lossy().replace('\\', "/");
        let absolute_path = static_dir.join(&relative_path);
        generated.push_str(&format!(
            "        {key:?} => Some(include_bytes!({absolute:?})),\n",
            key = key,
            absolute = absolute_path.to_string_lossy(),
        ));
    }

    generated.push_str("        _ => None,\n    }\n}\n");
    fs::write(generated_path, generated).expect("failed to write embedded asset map");
}
