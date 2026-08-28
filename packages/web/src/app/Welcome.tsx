/**
 * Premier écran vu quand le token manque : l'UI s'ouvre normalement via la
 * commande `memoria`, qui passe la clé d'accès dans l'URL. Passe par les 5
 * catalogues (règle « 5 langues dès la V1 »).
 */
import { CopyButton } from '../components/ui'
import { Card, CardContent } from '../components/ui/card'
import { useT } from '../i18n'
import { BrandMark } from './BrandMark'

export function Welcome() {
  const { t } = useT()
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-primary">
            <BrandMark />
            <span className="text-lg font-semibold text-foreground">Memoria</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{t('welcome.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('welcome.body')}</p>
          <div className="flex items-center gap-2">
            <pre className="flex-1 rounded-md bg-muted px-3 py-2 text-sm">memoria</pre>
            <CopyButton text="memoria" />
          </div>
          <p className="text-xs text-muted-foreground">{t('welcome.local')}</p>
        </CardContent>
      </Card>
    </div>
  )
}
