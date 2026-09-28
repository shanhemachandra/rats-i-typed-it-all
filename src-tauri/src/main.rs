// Prevents an extra console window opening alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rats_i_typed_it_all_lib::run()
}
