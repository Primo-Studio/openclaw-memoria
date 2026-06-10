export declare function newId(): string;
export declare function nowISO(): string;
export declare function sha256Hex(input: string | Buffer): string;
/** Token opaque pour instances/pairing — 32 octets url-safe. */
export declare function newToken(): string;
/** Code de pairing court lisible (à copier-coller dans le chat de l'agent). */
export declare function newPairingCode(): string;
/**
 * Estimation de tokens sans dépendance (≈ 4 caractères/token).
 * Sert au CAP DUR du budget d'injection — mieux vaut surestimer légèrement.
 */
export declare function estimateTokens(text: string): number;
export declare function toJson(value: unknown): string;
export declare function fromJsonArray(raw: string | null | undefined): string[];
/** Sérialisation Float32 little-endian pour les embeddings (format legacy conservé). */
export declare function vectorToBuffer(vec: ReadonlyArray<number> | Float32Array): Buffer;
export declare function bufferToVector(buf: Buffer): Float32Array;
//# sourceMappingURL=util.d.ts.map