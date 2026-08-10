//! Module P2P (stub pour l'instant).
//! On désactive les parties qui posent problème.
use std::sync::Mutex;

pub struct P2PState {
    pub peers: Mutex<Vec<String>>,
}

pub fn init_mdns_service() {
    println!("P2P/mDNS désactivé pour l'instant (stub)");
}
