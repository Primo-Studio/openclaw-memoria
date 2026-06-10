/**
 * Secrets (spec §9, décision D2) — GATE DUR :
 * la valeur d'un secret ne touche JAMAIS facts/.md/logs/audit/projection.
 * `SecretProvider` = coffre (Keychain macOS / Credential Manager / libsecret /
 * fallback AES-256-GCM). `Redactor` = détection+remplacement AVANT storeFact.
 */
export {};
//# sourceMappingURL=types.js.map