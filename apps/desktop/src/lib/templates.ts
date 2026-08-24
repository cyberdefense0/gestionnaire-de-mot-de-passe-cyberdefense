import type { CustomFieldType } from "../types";

export interface EntryTemplate {
  id: string;
  label: string;
  icon: string;
  description: string;
  /** item_type à utiliser */
  itemType: "password" | "note";
  /** Valeurs par défaut suggérées */
  defaults: {
    title?: string;
    category?: string;
    tags?: string[];
    notes?: string;
    customFields?: Array<{ label: string; field_type: CustomFieldType }>;
  };
}

function field(label: string, field_type: CustomFieldType): { label: string; field_type: CustomFieldType } {
  return { label, field_type };
}

export const ENTRY_TEMPLATES: EntryTemplate[] = [
  {
    id: "bank",
    label: "Compte bancaire",
    icon: "🏦",
    description: "Accès en ligne, numéro de carte, codes",
    itemType: "password",
    defaults: {
      category: "Finance",
      tags: ["banque"],
      customFields: [
        field("IBAN", "text"),
        field("BIC / SWIFT", "text"),
        field("Numéro de carte", "password"),
        field("Code PIN carte", "password"),
        field("Code CVV", "password"),
        field("Plafond mensuel", "text"),
      ],
      notes: "## Contacts\n- Service client : \n- Numéro de blocage carte : ",
    },
  },
  {
    id: "email",
    label: "Messagerie e-mail",
    icon: "📧",
    description: "Gmail, Outlook, boîte pro…",
    itemType: "password",
    defaults: {
      category: "Communication",
      tags: ["email"],
      customFields: [
        field("Serveur IMAP", "text"),
        field("Port IMAP", "text"),
        field("Serveur SMTP", "text"),
        field("Port SMTP", "text"),
        field("Code 2FA", "totp"),
      ],
    },
  },
  {
    id: "wifi",
    label: "Réseau Wi-Fi",
    icon: "📶",
    description: "Mot de passe de votre box, réseau invité…",
    itemType: "password",
    defaults: {
      category: "Maison",
      tags: ["wifi", "réseau"],
      customFields: [
        field("Nom du réseau (SSID)", "text"),
        field("Type de sécurité", "text"),
        field("Code administrateur box", "password"),
        field("IP de la box", "text"),
      ],
    },
  },
  {
    id: "server",
    label: "Accès serveur / SSH",
    icon: "🖥️",
    description: "VPS, NAS, hébergement…",
    itemType: "password",
    defaults: {
      category: "Technique",
      tags: ["serveur", "ssh"],
      customFields: [
        field("Hôte / IP", "text"),
        field("Port SSH", "text"),
        field("Utilisateur", "text"),
        field("Clé privée (nom du fichier)", "text"),
        field("Passphrase clé", "password"),
      ],
    },
  },
  {
    id: "passport",
    label: "Passeport / CNI",
    icon: "🛂",
    description: "Documents d'identité",
    itemType: "note",
    defaults: {
      category: "Documents",
      tags: ["identité"],
      notes:
        "## Passeport\n- Numéro : \n- Délivré le : \n- Expire le : \n- Lieu de délivrance : \n\n## Carte nationale d'identité\n- Numéro : \n- Délivrée le : \n- Expire le : ",
    },
  },
  {
    id: "insurance",
    label: "Assurance",
    icon: "🛡️",
    description: "Mutuelle, auto, habitation…",
    itemType: "note",
    defaults: {
      category: "Documents",
      tags: ["assurance"],
      notes:
        "## Informations contrat\n- Compagnie : \n- Numéro de contrat : \n- Numéro de sociétaire : \n\n## Contacts\n- Téléphone sinistres : \n- E-mail : \n\n## Échéance\n- Date de renouvellement : ",
    },
  },
  {
    id: "backup-codes",
    label: "Codes de secours 2FA",
    icon: "🔐",
    description: "Codes de récupération à usage unique",
    itemType: "note",
    defaults: {
      category: "Sécurité",
      tags: ["2fa", "codes-secours"],
      notes:
        "## Codes de secours — [NOM DU SERVICE]\nChaque code ne fonctionne qu'une seule fois.\n\n- \n- \n- \n- \n- \n- \n- \n- \n\n> Générés le : \n> Utilisés : 0 / 8",
    },
  },
  {
    id: "license",
    label: "Licence logicielle",
    icon: "🔑",
    description: "Clé d'activation, abonnement…",
    itemType: "password",
    defaults: {
      category: "Logiciels",
      tags: ["licence"],
      customFields: [
        field("Clé de licence", "password"),
        field("E-mail d'achat", "email"),
        field("Nombre d'appareils autorisés", "text"),
        field("Lien de téléchargement", "url"),
      ],
    },
  },
];
