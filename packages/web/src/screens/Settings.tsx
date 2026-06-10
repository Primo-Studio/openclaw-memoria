/**
 * Réglages (spec §14) : profil LLM, emplacement de stockage, mode de capture
 * (rappel — le sélecteur principal vit dans la barre latérale). Les routes
 * /v1/admin/llm_profile sont des « contrats » : 404 → « non disponible »,
 * jamais de crash.
 */
import { useEffect, useState } from 'react'
import {
  ApiError,
  getDoctor,
  getLlmProfile,
  setLlmProfile,
  type DoctorReport,
  type LlmProfile,
} from '../api'

const PROFILES: Array<{ id: LlmProfile; label: string; hint: string }> = [
  { id: '100-local', label: '100 % local', hint: 'Ollama uniquement — rien ne sort de la machine.' },
  { id: 'local-plus-cloud', label: 'Local + cloud', hint: 'Local par défaut, Claude (Anthropic) pour les tâches fines.' },
  { id: 'cloud', label: 'Cloud', hint: 'Claude pour l’extraction (votre clé), embeddings locaux.' },
]

export function Settings() {
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [profile, setProfile] = useState<LlmProfile | null>(null)
  const [profileUnavailable, setProfileUnavailable] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getDoctor().then(setDoctor).catch(() => setDoctor(null))
    getLlmProfile()
      .then(p => { setProfile(p); setProfileUnavailable(false) })
      .catch(() => setProfileUnavailable(true))
  }, [])

  const change = async (next: LlmProfile) => {
    const prev = profile
    setProfile(next)
    try {
      await setLlmProfile(next)
      setError(null)
    } catch (err) {
      setProfile(prev)
      setError(err instanceof ApiError ? err.message : 'Changement impossible.')
    }
  }

  return (
    <section>
      <header className="screen-head">
        <div>
          <h1>Réglages</h1>
          <p className="muted">Moteur d’IA et emplacement de votre mémoire — tout reste local.</p>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="settings-block">
        <h2>Moteur d’IA</h2>
        {profileUnavailable ? (
          <p className="muted">Réglage du profil non disponible sur ce service.</p>
        ) : profile === null ? (
          <div className="spinner-row"><span className="spinner" aria-hidden /> Chargement…</div>
        ) : (
          <div className="capture-options" role="radiogroup" aria-label="Profil LLM">
            {PROFILES.map(p => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={profile === p.id}
                className={`capture-option${profile === p.id ? ' capture-active' : ''}`}
                onClick={() => void change(p.id)}
              >
                <strong>{p.label}</strong>
                <div className="muted" style={{ fontSize: '0.75rem' }}>{p.hint}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="settings-block">
        <h2>Emplacement de stockage</h2>
        <pre className="command">{doctor?.storage_root ?? '~/.memoria/data'}</pre>
        <p className="muted">
          Dossier qui contient toutes vos mémoires (chiffrées pour les secrets). Pour le déplacer,
          modifiez <code>~/.memoria/config.toml</code> puis redémarrez le service.
        </p>
      </div>

      <div className="settings-block">
        <h2>Capture</h2>
        <p className="muted">
          Le mode de capture (automatique / revue d’abord / pause) se règle dans la barre latérale,
          toujours accessible.
        </p>
      </div>
    </section>
  )
}
