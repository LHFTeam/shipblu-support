/// <reference types="next/image-types/global" />

// `next-env.d.ts` carries this reference too, but Next writes that file and the
// repo ignores it, so `tsc --noEmit` in CI runs without it and a static image
// import — the help centre's illustrations — would read as a missing module.
