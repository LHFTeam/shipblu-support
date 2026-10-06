/**
 * What a message's inline pictures are doing, and what the list's live region
 * says about them — `AttachmentList` in the inbox draws it.
 *
 * A reducer rather than three `useState`s and handlers that read them, because
 * every decision here depends on more than one of the three. A handler can only
 * read the state of the render it came from, and an `<img>` error lands between
 * renders: the reopen of a preview whose picture failed while it was closed
 * read "loading" and said nothing. Here each action is decided against the state
 * it actually applies to. Pure, and so testable without a browser, which is the
 * only reason it is out of the component file.
 */

export type Load = 'loading' | 'loaded' | 'failed';

/**
 * Named apart from the DOM's `File`, which client code importing this also has
 * in scope. `kind` is what the file is in the conversation; it is absent for a
 * file shown only as a link, which can neither fail nor be announced, and the
 * wording reads absent as a picture.
 *
 * `name` is what the file is called aloud — its file name for a picture, and
 * the player's own name ("Audio, 21 KB") for a voice note or a video, so the
 * notice about a player names the control the agent just pressed rather than
 * the sixteen-digit media id WhatsApp stores a note under.
 *
 * A voice note's player is on the page from the start rather than opened from
 * its chip, so for this reducer it is always showing: its failure is announced
 * at once, where a closed picture's waits until it is opened.
 */
export type PreviewFile = { id: string; name: string; kind?: 'image' | 'audio' | 'video' };

const showing = (state: PreviewState, file: PreviewFile) =>
  file.kind === 'audio' || state.showing[file.id] === true;

export type PreviewState = {
  /**
   * A key exists once a preview has been opened, which is also when it mounts;
   * its value is whether it is showing now.
   */
  showing: Record<string, boolean>;
  /**
   * A key exists once the picture has first loaded or failed, or "Try again"
   * reset it — a mounted preview can have none yet. Read through `loadOf`.
   */
  loads: Record<string, Load>;
  /**
   * The live region's text, and which picture it is about. `seq` changes with
   * every notice so the same sentence twice is still a change to announce: two
   * failures one after another, or one failure reopened.
   */
  notice: { fileId: string; text: string; seq: number } | null;
  seq: number;
};

export type PreviewAction =
  | { type: 'toggle'; file: PreviewFile }
  | { type: 'settle'; file: PreviewFile; load: 'loaded' | 'failed' }
  | { type: 'retry'; file: PreviewFile };

export const initialPreviewState: PreviewState = { showing: {}, loads: {}, notice: null, seq: 0 };

export function loadOf(state: PreviewState, id: string): Load {
  return state.loads[id] ?? 'loading';
}

export function previewReducer(state: PreviewState, action: PreviewAction): PreviewState {
  const { file } = action;

  switch (action.type) {
    case 'toggle': {
      const opening = state.showing[file.id] !== true;
      const next = { ...state, showing: { ...state.showing, [file.id]: opening } };
      if (!opening) return withdraw(next, file.id);
      // "Expanded" is all the chip itself says, which reads as success over a
      // failure line nothing else mentions.
      return state.loads[file.id] === 'failed' ? announce(next, file) : next;
    }

    case 'settle': {
      const next = { ...state, loads: { ...state.loads, [file.id]: action.load } };
      if (action.load === 'loaded') return withdraw(next, file.id);
      // A failure behind a closed preview is told when it is opened, not now,
      // while the agent is looking at something else.
      return showing(state, file) ? announce(next, file) : next;
    }

    case 'retry':
      return withdraw({ ...state, loads: { ...state.loads, [file.id]: 'loading' } }, file.id);
  }
}

/**
 * Names the next steps as well as the failure: the controls sit under the whole
 * chip list, away from the chip that has focus, so nothing else says they exist.
 */
function announce(state: PreviewState, file: PreviewFile): PreviewState {
  const seq = state.seq + 1;
  return {
    ...state,
    seq,
    notice: {
      fileId: file.id,
      text: `${file.name} could not be ${file.kind === 'audio' || file.kind === 'video' ? 'played' : 'shown'} here. Try again, or open the file.`,
      seq,
    },
  };
}

/**
 * Drops a notice once it has stopped being true — retried, loaded or closed.
 *
 * A live region keeps its text after it is spoken, and a screen reader in
 * browse mode reads it again in place, so a stale one tells the agent a picture
 * on screen could not be shown. Removing text is not announced, so this is
 * silent. Only a notice about the same picture: another's failure may not have
 * been read yet.
 */
function withdraw(state: PreviewState, fileId: string): PreviewState {
  return state.notice?.fileId === fileId ? { ...state, notice: null } : state;
}
