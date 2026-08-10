//! Stéganographie LSB (Least Significant Bit).
//!
//! Chaque octet de payload est dispersé sur 8 pixels consécutifs (1 bit par
//! canal R, G ou B). Les 4 premiers octets encodent la longueur totale du
//! payload (u32 little-endian) — ce qui rend l'extraction autonome : pas
//! besoin que l'utilisateur note ou retrouve manuellement la taille.
//!
//! Format complet stocké dans l'image :
//!   [4 octets longueur LE] + [octets du payload]
//!
//! Contraintes :
//!   - Image d'entrée : PNG (ou tout format décodable par `image` 0.24).
//!     L'image de sortie est toujours sauvegardée en PNG (format sans perte).
//!   - Capacité max : (W × H × 3) / 8 octets. En pratique une image 800×600
//!     peut cacher ≈ 180 000 octets ; une 1920×1080 ≈ 777 000 octets.
//!     Le fichier .vault typique fait quelques Ko — largement suffisant.
//!   - Un seul bit par canal modifié → variation visuelle imperceptible
//!     (≤ 1 LSB de quantification), aucun artefact perceptible à l'œil nu.

use image::Pixel;

/// Itérateur sur les positions (x, y, canal) d'une image, dans l'ordre
/// row-major, en n'utilisant que les canaux R, G, B (pas alpha).
/// Un appel à `advance` consomme un bit du payload.
struct LsbCursor {
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    channel: u8, // 0=R 1=G 2=B
}

impl LsbCursor {
    fn new(width: u32, height: u32) -> Self {
        LsbCursor { width, height, x: 0, y: 0, channel: 0 }
    }

    fn has_more(&self) -> bool {
        self.y < self.height
    }

    /// Avance d'un canal. Retourne `(x, y, canal)` avant avance.
    fn next_position(&mut self) -> Option<(u32, u32, u8)> {
        if !self.has_more() {
            return None;
        }
        let pos = (self.x, self.y, self.channel);
        self.channel += 1;
        if self.channel == 3 {
            self.channel = 0;
            self.x += 1;
            if self.x == self.width {
                self.x = 0;
                self.y += 1;
            }
        }
        Some(pos)
    }

    fn bits_remaining(&self) -> usize {
        let pixels_done = (self.y * self.width + self.x) as usize;
        let total_pixels = (self.width * self.height) as usize;
        (total_pixels - pixels_done) * 3 + (2 - self.channel as usize)
    }
}

#[tauri::command]
pub fn embed_vault_in_image(
    image_path: String,
    vault_data: Vec<u8>,
    output_path: String,
) -> Result<(), String> {
    // 4 octets pour la longueur + données elles-mêmes
    let total_len = vault_data.len();
    let payload_with_header = {
        let mut p = Vec::with_capacity(4 + total_len);
        p.extend_from_slice(&(total_len as u32).to_le_bytes());
        p.extend_from_slice(&vault_data);
        p
    };

    let mut img = image::open(&image_path)
        .map_err(|e| format!("Impossible d'ouvrir l'image porteuse « {image_path} » : {e}"))?
        .into_rgba8(); // RGBA pour préserver la transparence éventuelle

    let (w, h) = img.dimensions();
    // Seulement R, G, B sont utilisés (pas A) → capacité = W*H*3 bits.
    let capacity_bits = (w as usize) * (h as usize) * 3;
    let needed_bits = payload_with_header.len() * 8;

    if needed_bits > capacity_bits {
        return Err(format!(
            "L'image est trop petite pour cacher le coffre : capacité {:.0} octets, \
             taille du coffre {} octets (+ 4 octets d'en-tête). \
             Choisissez une image plus grande.",
            capacity_bits / 8,
            total_len
        ));
    }

    let mut cursor = LsbCursor::new(w, h);

    for byte in &payload_with_header {
        for bit_idx in (0..8).rev() {
            let bit = (byte >> bit_idx) & 1;
            let (x, y, ch) = cursor
                .next_position()
                .expect("cursor épuisé — la vérification de capacité aurait dû empêcher ça");

            let mut pixel = img.get_pixel(x, y).to_rgba();
            // Remplace le LSB du canal ch (0=R, 1=G, 2=B) par `bit`.
            pixel[ch as usize] = (pixel[ch as usize] & 0xFE) | bit;
            img.put_pixel(x, y, image::Rgba(pixel.0));
        }
    }

    // Toujours sauvegarder en PNG : les formats avec perte (JPEG) écraseraient
    // les LSB modifiés et rendraient le payload illisible.
    let out = if output_path.to_lowercase().ends_with(".png") {
        output_path.clone()
    } else {
        format!("{output_path}.png")
    };

    img.save(&out)
        .map_err(|e| format!("Impossible d'écrire l'image de sortie « {out} » : {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn extract_vault_from_image(image_path: String) -> Result<Vec<u8>, String> {
    let img = image::open(&image_path)
        .map_err(|e| format!("Impossible d'ouvrir l'image « {image_path} » : {e}"))?
        .into_rgba8();

    let (w, h) = img.dimensions();

    // Lit `n_bytes` octets depuis les LSB de l'image à partir de la position du curseur.
    let read_bytes = |cursor: &mut LsbCursor, n_bytes: usize| -> Result<Vec<u8>, String> {
        let bits_needed = n_bytes * 8;
        if cursor.bits_remaining() < bits_needed {
            return Err(format!(
                "L'image ne contient pas assez de données (besoin de {n_bytes} octets, \
                 image trop petite ou mauvaise image)."
            ));
        }
        let mut result = vec![0u8; n_bytes];
        for byte in result.iter_mut() {
            for bit_idx in (0..8).rev() {
                let (x, y, ch) = cursor.next_position().unwrap();
                let pixel = img.get_pixel(x, y).to_rgba();
                let bit = pixel[ch as usize] & 1;
                *byte |= bit << bit_idx;
            }
        }
        Ok(result)
    };

    let mut cursor = LsbCursor::new(w, h);

    // Lit l'en-tête de 4 octets pour retrouver la longueur du payload.
    let header = read_bytes(&mut cursor, 4)?;
    let data_len = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;

    if data_len == 0 || data_len > 100 * 1024 * 1024 {
        return Err(
            "Longueur lue dans l'en-tête invalide (0 ou > 100 Mo). \
             Cette image ne semble pas contenir un coffre caché par cet outil, \
             ou elle a été re-compressée (JPEG), ce qui détruit les LSB."
                .to_string(),
        );
    }

    read_bytes(&mut cursor, data_len)
}
