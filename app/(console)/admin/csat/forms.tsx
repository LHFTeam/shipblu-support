'use client';

import { ErrorText, Field, Input, Notice, SuccessText, Toggle } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { InfoTip } from '@/components/tooltip';
import { RelativeTime } from '@/components/relative-time';
import { useActionForm } from '@/components/use-action-form';
import { ago } from '@/lib/format';
import {
  MAX_DELAY_MINUTES,
  MAX_META_EXPIRY_DAYS,
  MAX_RESURVEY_DAYS,
  MIN_META_EXPIRY_DAYS,
  MIN_RESURVEY_DAYS,
} from '@/lib/csat/limits';
import type { CsatSettings } from '@/lib/csat/settings';
import type { ActionState } from '@/lib/http/action-state';
import { saveSurveySettings } from './actions';

const INITIAL: ActionState = { error: null };

/**
 * The switch, the timing and the channels, as one form.
 *
 * Every channel starts off even once the switch is on, so turning surveys on
 * is two decisions — on, and where — rather than one that reaches every
 * customer at once. The row of channel toggles says how each one is delivered
 * today, because "Facebook" alone does not tell an admin whether the customer
 * gets a card in Messenger or a link they have to leave the app to open.
 */
export function SurveySettingsForm({ settings }: { settings: CsatSettings }) {
  const { state, form } = useActionForm(saveSurveySettings, INITIAL);

  return (
    <form
      {...form}
      className="flex flex-col gap-6 rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) p-(--density-card-pad)"
    >
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-1 text-sm font-semibold">
          Ask customers how it went
          <InfoTip label="Ask customers how it went">
            A while after a ticket is resolved, the customer is asked to rate the support from 1 to
            5, with an optional comment, on the channel the conversation happened on. The score is
            recorded against the ticket and the agent who handled it, and feeds the CSAT figures on
            the reports. A customer who writes back before the survey goes out gets their answer
            instead of a survey.
          </InfoTip>
        </div>

        <Toggle name="enabled" label="Surveys are on" defaultChecked={settings.enabled} />

        <p className="text-xs text-(--color-text-secondary)">
          {settings.changedAt ? (
            <RelativeTime at={settings.changedAt}>
              {(relative) =>
                `Last changed ${ago(relative)}${settings.changedBy ? ` by ${settings.changedBy}` : ''}.`
              }
            </RelativeTime>
          ) : (
            'Never switched on.'
          )}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Timing</h2>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Field
            className="sm:w-56"
            label="Send after"
            hint="Minutes after the ticket is resolved."
            explain={
              <>
                The grace in which a customer&rsquo;s &ldquo;one more thing&rdquo; reopens the
                ticket instead of being answered with a survey. The survey checks the ticket is
                still resolved when the time comes. A web chat is closed three days after it is
                resolved, by the built-in rule, and a closed chat can no longer show its survey: a
                delay of three days or more leaves web chat unsurveyed.
              </>
            }
          >
            <Input
              name="delayMinutes"
              type="number"
              min={0}
              max={MAX_DELAY_MINUTES}
              step={1}
              defaultValue={settings.delayMinutes}
            />
          </Field>

          <Field
            className="sm:w-56"
            label="On Facebook and Instagram"
            hint="Minutes. Empty to use the same delay."
            explain={
              <>
                Instagram&rsquo;s rating buttons, and Facebook&rsquo;s when Messenger refuses its
                card, can only be sent while Meta&rsquo;s 24-hour messaging window is open, counted
                from the customer&rsquo;s last message; Messenger&rsquo;s own card has seven days. A
                ticket resolved late in the 24 hours can miss them at the default delay; the recent
                list below says so when it happens.
              </>
            }
          >
            <Input
              name="metaDelayMinutes"
              type="number"
              min={0}
              max={MAX_DELAY_MINUTES}
              step={1}
              defaultValue={settings.metaDelayMinutes ?? ''}
              placeholder="same"
            />
          </Field>

          <Field
            className="sm:w-56"
            label="Don’t ask again for"
            hint="Days. A ticket resolved again inside this is not surveyed twice."
          >
            <Input
              name="resurveyAfterDays"
              type="number"
              min={MIN_RESURVEY_DAYS}
              max={MAX_RESURVEY_DAYS}
              step={1}
              defaultValue={settings.resurveyAfterDays}
            />
          </Field>

          <Field
            className="sm:w-56"
            label="Messenger card open for"
            hint="Days, 1 to 7."
            explain={
              <>
                How long the customer can still answer Messenger&rsquo;s feedback card after it
                arrives. Meta allows one to seven days; after that the card can no longer be
                answered.
              </>
            }
          >
            <Input
              name="metaExpiresInDays"
              type="number"
              min={MIN_META_EXPIRY_DAYS}
              max={MAX_META_EXPIRY_DAYS}
              step={1}
              defaultValue={settings.metaExpiresInDays}
            />
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Channels</h2>
        <Toggle
          name="surveyEmail"
          label="Email"
          hint="A link in an email. Portal tickets are answered by email, so this covers them too."
          defaultChecked={settings.channels.email}
        />
        <Toggle
          name="surveyWebchat"
          label="Web chat"
          hint="A card in the chat, answered without leaving it."
          defaultChecked={settings.channels.webchat}
        />
        <Toggle
          name="surveyFacebook"
          label="Facebook"
          hint="Messenger’s own feedback card, up to 7 days after the customer last wrote. Needs the privacy link below."
          defaultChecked={settings.channels.facebook}
        />
        <div className="flex flex-col gap-2 ps-6">
          <Field
            label="Privacy policy link"
            hint="Shown on Messenger’s card. Required for Facebook surveys."
            explain={
              <>
                Meta will not send its feedback card without a link to the business&rsquo;s privacy
                policy, so Facebook tickets are not surveyed until one is set.
              </>
            }
          >
            <Input
              name="privacyUrl"
              type="url"
              inputMode="url"
              dir="ltr"
              placeholder="https://"
              defaultValue={settings.privacyUrl ?? ''}
            />
          </Field>
          {settings.lastTemplateRefusal ? (
            <Notice tone="warning" icon>
              <RelativeTime at={settings.lastTemplateRefusal.at}>
                {(relative) => `Messenger last refused the feedback card ${ago(relative)}:`}
              </RelativeTime>{' '}
              <span className="whitespace-pre-line">{settings.lastTemplateRefusal.text}</span> A
              survey it refuses goes as rating buttons instead, while the 24-hour window is open.
            </Notice>
          ) : null}
        </div>
        <Toggle
          name="surveyInstagram"
          label="Instagram"
          hint="Five rating buttons under the question, only while the 24-hour window is open."
          defaultChecked={settings.channels.instagram}
        />
        <Toggle
          name="surveyApi"
          label="API"
          hint="Tickets opened through the API, by email, when the contact has an address."
          defaultChecked={settings.channels.api}
        />
        <p className="text-xs text-(--color-text-secondary)">
          WhatsApp customers are not answered from this platform, so they are not surveyed from it
          either.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Behaviour</h2>
        <Toggle
          name="surveyRuleResolved"
          label="Survey tickets an automation resolved"
          hint="Off, a ticket a rule resolved is left alone; an agent’s resolve is always surveyed."
          defaultChecked={settings.surveyRuleResolved}
        />
      </section>

      <ErrorText>{state.error}</ErrorText>
      {state.ok ? <SuccessText>Saved.</SuccessText> : null}

      <SubmitButton className="self-start" idle="Save" busy="Saving…" />
    </form>
  );
}
