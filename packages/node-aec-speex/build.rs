fn main() {
    // Link against speexdsp from devbox nix profile
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let devbox_lib = format!("{}/../../../.devbox/nix/profile/default/lib", manifest_dir);
    // Also check if DEVBOX_LIB_PATH is set
    if let Ok(lib_path) = std::env::var("LIBRARY_PATH") {
        for p in lib_path.split(':') {
            println!("cargo:rustc-link-search=native={}", p);
        }
    }
    println!("cargo:rustc-link-search=native={}", devbox_lib);
    println!("cargo:rustc-link-lib=dylib=speexdsp");
}
