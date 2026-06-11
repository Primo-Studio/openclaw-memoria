/**
 * Personnes — qui peut parler aux agents ? Néto le plus souvent, mais aussi
 * Badette, des stagiaires, un client… Chaque personne a des identifiants
 * (numéro Telegram/WhatsApp, e-mail, handle) qui permettent à l'agent de
 * RECONNAÎTRE son interlocuteur, et des notes (rôle, ce qu'on peut partager).
 */
import { useState, type FormEvent } from 'react'
import {
  addPersonIdentifier,
  createPerson,
  deletePerson,
  getPersons,
  identifyInterlocutor,
  removePersonIdentifier,
  updatePerson,
  type InterlocutorMatch,
  type PersonIdentifier,
  type PersonProfile,
} from '../api'
import { ConfirmButton, EmptyState, ErrorBanner, Spinner, humanError, useLoad } from '../components/ui'

const KINDS: Array<{ id: PersonIdentifier['kind']; label: string; placeholder: string }> = [
  { id: 'telegram', label: 'Telegram', placeholder: '@handle ou id numérique' },
  { id: 'whatsapp', label: 'WhatsApp', placeholder: '+594 6xx xx xx xx' },
  { id: 'phone', label: 'Téléphone', placeholder: '+594 6xx xx xx xx' },
  { id: 'email', label: 'E-mail', placeholder: 'prenom@exemple.com' },
  { id: 'handle', label: 'Handle', placeholder: 'pseudo' },
  { id: 'other', label: 'Autre', placeholder: 'identifiant' },
]

function kindLabel(kind: string): string {
  return KINDS.find(k => k.id === kind)?.label ?? kind
}

export function Persons() {
  const { state, reload } = useLoad(getPersons)
  const [error, setError] = useState<string | null>(null)

  return (
    <section>
      <header className="screen-head">
        <div>
          <h1>Personnes</h1>
          <p className="muted">
            Aide les agents à savoir <strong>à qui ils parlent</strong>. Renseigne les identifiants
            (Telegram, WhatsApp, e-mail) qui permettent de reconnaître chaque personne, et ce qu'on peut partager avec elle.
          </p>
        </div>
      </header>

      {error && <ErrorBanner message={error} />}

      <IdentifyTester onError={setError} />

      <AddPerson onAdded={reload} onError={setError} />

      {state.status === 'loading' && <Spinner />}
      {state.status === 'error' && <ErrorBanner message={state.message} onRetry={reload} />}
      {state.status === 'ready' &&
        (state.data.length === 0 ? (
          <EmptyState title="Aucune personne enregistrée" body="Ajoute Néto, Badette, tes stagiaires ou tes clients pour que les agents les reconnaissent." />
        ) : (
          <ul className="person-list">
            {state.data.map(p => (
              <PersonCard key={p.id} person={p} onChange={reload} onError={setError} />
            ))}
          </ul>
        ))}
    </section>
  )
}

function IdentifyTester({ onError }: { onError: (m: string) => void }) {
  const [kind, setKind] = useState<PersonIdentifier['kind'] | 'name'>('telegram')
  const [value, setValue] = useState('')
  const [result, setResult] = useState<InterlocutorMatch | null | 'none'>(null)

  const test = async (e: FormEvent) => {
    e.preventDefault()
    if (!value.trim()) return
    try {
      const input = kind === 'name' ? { name: value } : { [kind]: value }
      const match = await identifyInterlocutor(input)
      setResult(match ?? 'none')
    } catch (err) {
      onError(humanError(err))
    }
  }

  return (
    <div className="settings-block">
      <h2>Tester l'identification</h2>
      <p className="muted">Colle un numéro, un e-mail ou un nom : tu verras qui l'agent reconnaîtrait.</p>
      <form className="identify-row" onSubmit={test}>
        <select value={kind} onChange={e => setKind(e.target.value as PersonIdentifier['kind'] | 'name')}>
          {KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
          <option value="name">Nom</option>
        </select>
        <input type="text" value={value} placeholder="valeur à reconnaître" onChange={e => setValue(e.target.value)} />
        <button type="submit" className="btn btn-primary">Identifier</button>
      </form>
      {result === 'none' && <p className="muted" style={{ marginTop: '0.6rem' }}>Aucune correspondance → l'agent supposera que c'est l'utilisateur (Néto).</p>}
      {result && result !== 'none' && (
        <div className="identify-result">
          <strong>{result.person.display_name}</strong>
          {result.person.relation && <span className="badge badge-theme">{result.person.relation}</span>}
          {result.person.notes && <p className="muted">{result.person.notes}</p>}
          {result.known.length > 0 && (
            <ul className="fact-list">
              {result.known.slice(0, 5).map((f, i) => <li key={i} className="fact-card"><p className="fact-content">{f}</p></li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function AddPerson({ onAdded, onError }: { onAdded: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState('')
  const [relation, setRelation] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    try {
      await createPerson({ display_name: name.trim(), relation: relation.trim() || undefined })
      setName('')
      setRelation('')
      onAdded()
    } catch (err) {
      onError(humanError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="add-person" onSubmit={submit}>
      <input type="text" value={name} placeholder="Nom (ex. Badette)" onChange={e => setName(e.target.value)} />
      <input type="text" value={relation} placeholder="Relation (ex. collaboratrice, stagiaire, client)" onChange={e => setRelation(e.target.value)} />
      <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>Ajouter</button>
    </form>
  )
}

function PersonCard({ person, onChange, onError }: { person: PersonProfile; onChange: () => void; onError: (m: string) => void }) {
  const [notes, setNotes] = useState(person.notes ?? '')
  const [relation, setRelation] = useState(person.relation ?? '')
  const [idKind, setIdKind] = useState<PersonIdentifier['kind']>('telegram')
  const [idValue, setIdValue] = useState('')

  const saveMeta = async () => {
    try {
      await updatePerson(person.id, { relation: relation.trim() || null, notes: notes.trim() || null })
      onChange()
    } catch (err) {
      onError(humanError(err))
    }
  }

  const addId = async (e: FormEvent) => {
    e.preventDefault()
    if (!idValue.trim()) return
    try {
      await addPersonIdentifier(person.id, idKind, idValue.trim())
      setIdValue('')
      onChange()
    } catch (err) {
      onError(humanError(err))
    }
  }

  const dirty = notes !== (person.notes ?? '') || relation !== (person.relation ?? '')

  return (
    <li className="person-card">
      <div className="person-head">
        <strong>{person.display_name}</strong>
        {person.user_id && <span className="badge badge-ok">utilisateur</span>}
        <ConfirmButton label="Supprimer" confirmLabel="Supprimer cette personne ?" onConfirm={async () => {
          try { await deletePerson(person.id); onChange() } catch (err) { onError(humanError(err)) }
        }} />
      </div>

      <div className="person-fields">
        <input type="text" value={relation} placeholder="Relation (rôle)" onChange={e => setRelation(e.target.value)} />
        <textarea value={notes} placeholder="Notes : ce qu'on peut partager avec elle, son rôle, ses préférences…" onChange={e => setNotes(e.target.value)} rows={2} />
        {dirty && <button type="button" className="btn btn-primary" onClick={() => void saveMeta()}>Enregistrer</button>}
      </div>

      <div className="person-idents">
        {person.identifiers.length === 0 && <span className="muted">Aucun identifiant — l'agent ne pourra pas la reconnaître automatiquement.</span>}
        {person.identifiers.map(id => (
          <span key={id.id} className="ident-chip">
            <span className="ident-kind">{kindLabel(id.kind)}</span> {id.value}
            <button type="button" className="ident-x" aria-label="Retirer" onClick={async () => {
              try { await removePersonIdentifier(id.id); onChange() } catch (err) { onError(humanError(err)) }
            }}>✕</button>
          </span>
        ))}
      </div>

      <form className="ident-add" onSubmit={addId}>
        <select value={idKind} onChange={e => setIdKind(e.target.value as PersonIdentifier['kind'])}>
          {KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        <input type="text" value={idValue} placeholder={KINDS.find(k => k.id === idKind)?.placeholder} onChange={e => setIdValue(e.target.value)} />
        <button type="submit" className="btn btn-ghost" disabled={!idValue.trim()}>+ identifiant</button>
      </form>
    </li>
  )
}
