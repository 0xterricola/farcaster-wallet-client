import { lazyWithPreload, PreloadableComponent } from './helpers';
type ComposerComponent =
  typeof import('~/components/composer/Composer').Composer;

export const LoginQRCode = lazyWithPreload(() =>
  import('~/components/login/LoginQRCode').then((res) => ({
    default: res.LoginQRCode,
  })),
);

export const Composer: PreloadableComponent<ComposerComponent> =
  lazyWithPreload(() =>
    import('~/components/composer/Composer').then((res) => ({
      default: res.Composer,
    })),
  );

/* The cast composer's modal is the OTHER door into the same code: everything
   that opens a composer from a feed, a conversation or a link goes through it,
   and it is rendered by two modules that are themselves in the entry chunk
   (`~/contexts/CastComposerSessionProvider`, `~/components/Snap/SnapRenderer`).

   It is lazy because it drags the composer in with it, and the composer is
   `draft-js` plus its mention/emoji/linkify plugins — 313,711 bytes of editor
   that nothing on the feed's first paint opens. MEASURED (2026-10-22, card
   t_648a3e4c): with the static import, `index.html` modulepreloaded the whole
   editor on every cold load. Nothing here holds a ref to the modal, so this is
   only about which chunk the editor lives in: it now arrives when someone
   opens a composer. */
type ComposeCastModalComponent =
  typeof import('~/components/modals/ComposeCastModal').ComposeCastModal;

export const ComposeCastModal: PreloadableComponent<ComposeCastModalComponent> =
  lazyWithPreload(() =>
    import('~/components/modals/ComposeCastModal').then((res) => ({
      default: res.ComposeCastModal,
    })),
  );

// Frames v1 deprecated: FarcasterFrameAttachment removed

export const PayUserDialog = lazyWithPreload(() =>
  import('~/components/payUser/PayUserDialog').then((res) => ({
    default: res.PayUserDialog,
  })),
);

/* A sealed cast in a feed, and a key someone shared in one: both are rare enough
   that their code (crypto, envelope reading) is imported the moment one appears,
   not with the bundle. */
export const SealedCastView = lazyWithPreload(() =>
  import('~/components/sealed/SealedCastView').then((res) => ({
    default: res.SealedCastView,
  })),
);

export const SealedKeyNotice = lazyWithPreload(() =>
  import('~/components/sealed/SealedKeyNotice').then((res) => ({
    default: res.SealedKeyNotice,
  })),
);

/* The look editor: the colour controls, the sliders and the share call, all of
   which only exist once someone opens Settings → Theme → "Make your own".
   Nothing on a feed needs them, so they live in their own chunk and the entry
   chunk stays the size it was (card t_d85d8520 keeps that budget). */
type LookEditorComponent =
  typeof import('~/components/looks/LookEditor').LookEditor;

export const LookEditorModal: PreloadableComponent<LookEditorComponent> =
  lazyWithPreload(() =>
    import('~/components/looks/LookEditor').then((res) => ({
      default: res.LookEditor,
    })),
  );
