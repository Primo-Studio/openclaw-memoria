/**
 * Coffre — les secrets (clés API, mots de passe…) détectés dans les
 * conversations sont automatiquement mis à l'abri : Memoria ne garde qu'une
 * RÉFÉRENCE, la valeur vit dans le coffre du système (Keychain macOS / coffre
 * chiffré). Cet écran montre ce qui est protégé — jamais la valeur.
 */
import { getSecrets } from '../api'
import { ErrorBanner, Spinner, useLoad } from '../components/ui'

export function Vault() {
  const { state, reload } = useLoad(getSecrets)

  return (
    <section>
      <header className="screen-head">
        <div>
          <h1>Coffre</h1>
          <p className="muted">Clés et mots de passe détectés et mis à l’abri automatiquement — la valeur reste chiffrée.</p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={reload}>Actualiser</button>
      </header>

      <div className="vault-explainer">
        🔒 Quand un agent rencontre une clé API ou un mot de passe, Memoria le remplace par une
        référence <code>[secret:…]</code> avant de l’enregistrer. La vraie valeur part dans le coffre
        du système. <strong>Elle n’apparaît jamais</strong> dans la mémoire, les exports ou les logs.
      </div>

      {state.status === 'loading' && <Spinner />}
      {state.status === 'error' && <ErrorBanner message={state.message} onRetry={reload} />}
      {state.status === 'ready' && (
        state.data.length === 0 ? (
          <div className="empty-state">
            <p>Aucun secret au coffre pour l’instant.</p>
            <p className="muted">C’est normal : le coffre se remplit dès qu’un agent croise une clé ou un mot de passe.</p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Référence</th><th>Type</th><th>Emplacement</th><th>Ajouté</th></tr>
            </thead>
            <tbody>
              {state.data.map(s => (
                <tr key={s.name}>
                  <td><code>{s.name}</code></td>
                  <td>{s.service ?? '—'}</td>
                  <td className="muted">{s.location.split(':')[0]}</td>
                  <td className="muted">{new Date(s.created_at).toLocaleDateString('fr-FR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </section>
  )
}
