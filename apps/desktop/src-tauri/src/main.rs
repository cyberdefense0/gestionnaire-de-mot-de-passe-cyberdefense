// Empêche l'ouverture d'une console supplémentaire sur Windows en mode release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    password_manager_lib::run();
}
