fn main() {
    println!("cargo:rerun-if-env-changed=MAESTRO_PRODUCT_VERSION");
    let version = std::env::var("MAESTRO_PRODUCT_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_owned());
    println!("cargo:rustc-env=MAESTRO_PRODUCT_VERSION={version}");
    tauri_build::build()
}
