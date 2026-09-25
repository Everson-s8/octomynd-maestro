// No console window next to the setup UI in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    maestro_setup_lib::run()
}
