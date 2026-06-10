import type { ServerResponse } from 'node:http';
/** Localise le dist de l'UI : option explicite > @memoria/web/dist résolu localement. */
export declare function findUiDist(explicit?: string): string | null;
/** Sert /ui/* depuis distDir. Retourne false si le chemin ne nous concerne pas. */
export declare function serveUi(pathname: string, distDir: string, res: ServerResponse): boolean;
//# sourceMappingURL=static.d.ts.map