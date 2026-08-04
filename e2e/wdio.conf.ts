import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

// Config WebdriverIO pour piloter l'app via tauri-driver (voir e2e/README.md
// pour le pourquoi de cette approche — c'est le pattern officiel Tauri v2 :
// https://v2.tauri.app/develop/tests/webdriver/).
//
// ⚠️ Suppose que `npm run tauri build -- --debug` a déjà été lancé côté
// projet racine, et que `tauri-driver` est installé (`cargo install
// tauri-driver`). Non vérifié dans le sandbox de dev — voir DEV_NOTES.md.

const APP_BINARY = path.resolve(
  __dirname,
  "../src-tauri/target/debug/coffre" // adapter si le nom du binaire diffère (voir `[package].name` dans src-tauri/Cargo.toml)
);

let driverProcess: ChildProcess | undefined;

export const config: WebdriverIO.Config = {
  hostname: "localhost",
  port: 4444,
  specs: ["./tests/**/*.spec.ts"],
  maxInstances: 1,
  capabilities: [
    {
      // @ts-expect-error -- capacité spécifique tauri-driver, absente des types WebDriver standards
      "tauri:options": { application: APP_BINARY },
      browserName: "wry",
    },
  ],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 60000 },

  // tauri-driver doit tourner en amont (voir README : `tauri-driver --port 4444`
  // dans un terminal séparé) — on ne le relance pas automatiquement ici pour
  // rester simple et explicite sur ce qui doit être lancé à la main.
  onPrepare: () => {
    const check = spawnSync("tauri-driver", ["--version"]);
    if (check.status !== 0) {
      throw new Error(
        "tauri-driver introuvable dans le PATH. Installez-le avec `cargo install tauri-driver --locked`, " +
          "puis lancez-le manuellement (`tauri-driver --port 4444`) avant `npm test`."
      );
    }
  },
};
