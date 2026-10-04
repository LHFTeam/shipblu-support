import { viewerIsTeamMember } from '@/lib/widget/audience';
import { ChatWidget } from './chat';

/**
 * What every help-centre page carries whatever its language: the chat.
 *
 * Here rather than in `[locale]/layout.tsx` because that layout is replaced on
 * every language switch, and the chat has to outlive one — see `ChatWidget`.
 * This layout is kept across the switch, so its gate is not asked again then;
 * it is asked on every full load, and after any server action that sets a
 * cookie, which is how signing in here reaches it.
 *
 * Not for a signed-in team member. The launcher is a customer's way in, and
 * this is a surface the team reads on too — see `viewerIsTeamMember`. Left out
 * rather than hidden with CSS: the snippet is then never fetched,
 * `chatWidget()` stays null, and the tracking page's "Ask support" falls back
 * to the form link it already carries as its `href`, which is exactly what that
 * fallback is there for.
 *
 * `ChatWidget` renders nothing — the snippet appends its own launcher to the
 * document body, as it does on any other host page. In the layout rather than
 * on one page because a visitor who cannot find an answer gives up wherever
 * they happen to be, most often on a search that returned nothing.
 */
export default async function HelpLayout({ children }: { children: React.ReactNode }) {
  const isTeamMember = await viewerIsTeamMember();

  return (
    <>
      {children}
      {isTeamMember ? null : <ChatWidget />}
    </>
  );
}
