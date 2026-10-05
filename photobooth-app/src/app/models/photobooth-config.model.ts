export interface PhotoboothBranding {
  /** App UI logo under `config/branding/` — attract, QR, style picker. */
  logoFile: string | null;
  /** AI reference logo under `config/branding/` — signage, products, accessories in generated photos. */
  aiLogoFile: string | null;
  /**
   * Optional capture pose guideline under `config/branding/`.
   * When null, guest capture uses theme `zyn/cameraoverlay.png`.
   */
  cameraOverlayFile: string | null;
  /** Display name used in AI prompts when `{brand}` appears. */
  brandName: string | null;
  /** When true and `aiLogoFile` exists, use it during AI generation. */
  applyBrandToAi: boolean;
}

export interface PhotoboothCopyAttract {
  icon: string;
  /** Brand line under logo (e.g. tagline). */
  tagline: string;
  /** Scale multiplier for main attract text block (title + subtitle). */
  mainScale: number;
  /** Scale multiplier for top brand block (logo + tagline). */
  topScale: number;
  title: string;
  subtitle: string;
  /** Primary CTA label (e.g. Tap to Start). */
  ctaLabel: string;
  startAria: string;
  adminLink: string;
}

export interface PhotoboothCopyQr {
  icon: string;
  title: string;
  subtitle: string;
  /** Shown briefly after a valid scan / unlock code (keyboard flow). */
  scanSuccess: string;
  /** Small footer line under primary actions. */
  footer: string;
  codeLabel: string;
  ok: string;
  back: string;
  invalidCode: string;
  debugHint: string;
  bypassCode: string;
}

export interface PhotoboothCopyCapture {
  /** Legacy / admin — optional secondary heading when not using ready flow. */
  sideTitle: string;
  instructions: string;
  starting: string;
  /** Main heading on capture (e.g. Get Ready). */
  readyTitle: string;
  /** Lead line under heading (e.g. center yourself…). */
  readySubtitle: string;
  /** Line below the preview stage (e.g. hold still). */
  footerHint: string;
  /** Small line under countdown (e.g. Smile — capturing soon). */
  smileHint: string;
  /** Shown on preview while shutter / frame processing runs. */
  capturing: string;
  /** Guest tap to start the countdown (HTML TAKE PHOTO). */
  takePhoto: string;
}

export interface PhotoboothCopyResult {
  title: string;
  loading: string;
  savedPrefix: string;
  retake: string;
  submit: string;
  /** Preview screen: keep this photo — uploads, then shows share/print/finish. */
  confirmPhoto: string;
  /** Button to run OpenAI image generation */
  generateAi: string;
  generatingAi: string;
  aiPreviewTitle: string;
  aiErrorPrefix: string;
  /** Gallery page (paired original + AI) */
  aiGalleryTitle: string;
  galleryThumbOriginal: string;
  galleryThumbAi: string;
  galleryBackToResult: string;
  galleryFinish: string;
  /** Expandable panel during generation — not live model “reasoning”; staged status only. */
  thinkingSummary: string;
  thinkingStepAnalyze: string;
  thinkingStepPlan: string;
  /** Shown during inpainting when a branded background is selected. */
  thinkingStepBackground: string;
  thinkingStepImage: string;
  thinkingFootnote: string;
  /** Moments remote gallery share */
  share: string;
  sharing: string;
  shareQrTitle: string;
  shareQrHint: string;
  shareBack: string;
  uploadFailed: string;
  /** One-shot print on the result / final page (when printing is enabled). */
  print: string;
  printing: string;
  printed: string;
  printFailed: string;
  /** Dual-cell cut sheet from the original capture (normal result only). */
  makePhysical: string;
  remakePhysical: string;
  makingPhysical: string;
  physicalErrorPrefix: string;
  makeFramed: string;
  remakeFramed: string;
  makingFramed: string;
  framedErrorPrefix: string;
}

export interface PhotoboothGalleryConfig {
  /** Push captures to the ZYN cloud dashboard. */
  enabled: boolean;
  /** Cloud dashboard base URL, e.g. http://127.0.0.1:3020 */
  apiBaseUrl: string;
  /** Shared upload token (same as UPLOAD_TOKEN on the cloud dashboard). */
  uploadToken: string;
  /** Daily session slug prefix → `{prefix}-YYYY-MM-DD`. */
  sessionPrefix: string;
  uploadOriginal: boolean;
  uploadFramed: boolean;
  uploadAi: boolean;
  /** Dual-column cut sheets — stored for admin download, not guest wall. */
  uploadPhysical: boolean;
}

export const PHOTOBOOTH_DEFAULT_GALLERY: PhotoboothGalleryConfig = {
  enabled: true,
  apiBaseUrl: 'http://127.0.0.1:3020',
  uploadToken: 'zyn-upload',
  sessionPrefix: 'zyn',
  uploadOriginal: false,
  uploadFramed: false,
  uploadAi: true,
  uploadPhysical: false,
};

export interface PhotoboothCaptureConfig {
  /** Seconds shown before shutter (3, 5, etc.). */
  countdownSeconds: number;
}

export const PHOTOBOOTH_DEFAULT_CAPTURE: PhotoboothCaptureConfig = {
  countdownSeconds: 5,
};

/** Guest-flow unattended safeguards (selection / preview / capture). */
export interface PhotoboothKioskConfig {
  /**
   * Seconds of no touch/keyboard on cans / details / capture / review / preview
   * before clearing the session and returning to attract. `0` disables.
   */
  idleTimeoutSeconds: number;
}

export const PHOTOBOOTH_DEFAULT_KIOSK: PhotoboothKioskConfig = {
  idleTimeoutSeconds: 90,
};

export interface PhotoboothDebugConfig {
  /** When true, Admin → Debug shows a live log panel (and a floating dock on guest screens). */
  enabled: boolean;
  /** When true, after capture the kiosk waits for AI and shows the generated image to check. */
  showPreviewAfterGenerate: boolean;
}

export const PHOTOBOOTH_DEFAULT_DEBUG: PhotoboothDebugConfig = {
  enabled: false,
  showPreviewAfterGenerate: false,
};

export interface PhotoboothFaceBox {
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
}

export const PHOTOBOOTH_DEFAULT_FACE: PhotoboothFaceBox = {
  xPercent: 40.5,
  yPercent: 0.4,
  widthPercent: 19,
  heightPercent: 18,
};

/** Centered full-body 9:16 driver portraits (all Woods Final Assets). */
export const PHOTOBOOTH_PORTRAIT_FACE: PhotoboothFaceBox = {
  xPercent: 40.5,
  yPercent: 0.4,
  widthPercent: 19,
  heightPercent: 18,
};

export interface PhotoboothCan {
  id: string;
  label: string;
  strength?: string;
  colorTreatment?: string;
  tag?: string;
  prompt: string;
  inpaintPrompt?: string;
  useInpainting?: boolean;
  /** Driver head box on this can's unique scene (percent of the composition). */
  face?: PhotoboothFaceBox;
}

export interface PhotoboothEmailConfig {
  enabled: boolean;
  provider: 'sendgrid';
  /** SendGrid mail send endpoint (override for proxies / EU). */
  apiUrl: string;
  /** Stored on disk only — never sent to the renderer. */
  apiKey?: string;
  apiKeyConfigured?: boolean;
  from: string;
  fromName: string;
  subject: string;
  body: string;
}

export const PHOTOBOOTH_DEFAULT_EMAIL: PhotoboothEmailConfig = {
  enabled: false,
  provider: 'sendgrid',
  apiUrl: 'https://api.sendgrid.com/v3/mail/send',
  from: '',
  fromName: 'ZYN Photobooth',
  subject: 'Your ZYN photo',
  body: 'Thanks for visiting the ZYN photobooth. Your photo is attached.',
};

export const PHOTOBOOTH_DEFAULT_OPENAI_API_URL = 'https://api.openai.com/v1';

export interface PhotoboothDisplayConfig {
  apiPort: number;
  apiToken: string;
  filter: 'all' | 'today' | 'range' | 'tags' | 'picked';
  tags: string[];
  pickedIds: string[];
  excludedIds: string[];
  rangeFrom: string | null;
  rangeTo: string | null;
  intervalMs: number;
}

export const PHOTOBOOTH_DEFAULT_DISPLAY: PhotoboothDisplayConfig = {
  apiPort: 3040,
  apiToken: 'zyn-display',
  filter: 'today',
  tags: [],
  pickedIds: [],
  excludedIds: [],
  rangeFrom: null,
  rangeTo: null,
  intervalMs: 8000,
};

export const HEAD_SWAP_PROMPT =
  "Clean seamless head replacement: guest likeness at the same size as the original driver head (not larger). No oval outline. Keep the driver's body and scene.";

export const HEAD_SWAP_INPAINT_PROMPT =
  "CLEAN SEAMLESS HEAD REPLACEMENT. Image 1 is this can's F1 scene with a small guest-head reference on the driver. Image 2 is a tight crop of the guest's real head. Replace the driver head with the guest at NATURAL PROPORTION — the head must match the original driver head size relative to the shoulders (do not enlarge). Exact guest likeness: eyes, nose, mouth, jaw, skin, hair. Completely erase the old driver head/hair. NO oval outline, cutout edge, mask ring, or halo. Blend the neck into the suit collar only. Keep the driver's body, crossed arms, hands, racing suit, pose, car, pit, camera angle, and lighting unchanged. Do not copy guest clothing or booth background.";

export const PHOTOBOOTH_DEFAULT_CANS: PhotoboothCan[] = [
  {
    id: 'cool-mint',
    label: 'Arctic Mint',
    strength: '11mg',
    colorTreatment: 'arctic mint blue',
    tag: 'cool-mint',
    prompt: HEAD_SWAP_PROMPT,
    inpaintPrompt: HEAD_SWAP_INPAINT_PROMPT,
    useInpainting: true,
    face: { ...PHOTOBOOTH_DEFAULT_FACE },
  },
  {
    id: 'wintergreen',
    label: 'Chill',
    strength: '1.5mg',
    colorTreatment: 'chill silver',
    tag: 'wintergreen',
    prompt: HEAD_SWAP_PROMPT,
    inpaintPrompt: HEAD_SWAP_INPAINT_PROMPT,
    useInpainting: true,
    face: { ...PHOTOBOOTH_DEFAULT_FACE },
  },
  {
    id: 'peppermint',
    label: 'Peppermint Frost',
    strength: '9mg',
    colorTreatment: 'peppermint frost blue',
    tag: 'peppermint',
    prompt: HEAD_SWAP_PROMPT,
    inpaintPrompt: HEAD_SWAP_INPAINT_PROMPT,
    useInpainting: true,
    face: { ...PHOTOBOOTH_PORTRAIT_FACE },
  },
  {
    id: 'spearmint',
    label: 'Spearmint',
    strength: '6mg',
    colorTreatment: 'spearmint green',
    tag: 'spearmint',
    prompt: HEAD_SWAP_PROMPT,
    inpaintPrompt: HEAD_SWAP_INPAINT_PROMPT,
    useInpainting: true,
    face: { ...PHOTOBOOTH_PORTRAIT_FACE },
  },
  {
    id: 'cinnamon',
    label: 'Cinnamon',
    strength: '8mg',
    colorTreatment: 'cinnamon burgundy',
    tag: 'cinnamon',
    prompt: HEAD_SWAP_PROMPT,
    inpaintPrompt: HEAD_SWAP_INPAINT_PROMPT,
    useInpainting: true,
    face: { ...PHOTOBOOTH_PORTRAIT_FACE },
  },
  {
    id: 'citrus',
    label: 'Citrus',
    strength: '3mg',
    colorTreatment: 'citrus lime',
    tag: 'citrus',
    prompt: HEAD_SWAP_PROMPT,
    inpaintPrompt: HEAD_SWAP_INPAINT_PROMPT,
    useInpainting: true,
    face: { ...PHOTOBOOTH_PORTRAIT_FACE },
  },
];

export interface PhotoboothPrintConfig {
  /** Show a one-shot Print button on the result / final gallery screen. */
  enabled: boolean;
  /** Enqueue a 4x6 print when AI finishes (kiosk printer). */
  autoPrint: boolean;
  /**
   * Windows printer queue name.
   * Empty / null = auto-pick USB DNP/RX1 or Canon/SELPHY, then Wi‑Fi if allowWifiPrinters.
   */
  printerName: string | null;
  /**
   * Print scale vs page: 1.0 = exact fit, >1 overscans (hide white edges),
   * <1 shrinks (safe margin when the printer trims edges). Range ~0.90–1.12.
   * Physical-frame cut sheets ignore this and print 1:1 on 148×100 mm postcard stock.
   */
  bleedScale: number;
  /**
   * White margin on the left and right of framed (digital frame) prints so SELPHY
   * borderless overscan does not eat the decorative border. Ignored for unframed camera JPEGs.
   */
  framedEdgeInsetMm: number;
  /**
   * Extra white at the bottom only. 3:2 frames are slightly wider than 148×100 mm stock,
   * and SELPHY overscans the trailing edge more than the sides.
   */
  framedBottomExtraMm: number;
  /** Include Wi‑Fi / IPP / WSD queues in the printer list (USB is still preferred). */
  allowWifiPrinters: boolean;
  /** Burn local capture date/time onto the printed photo corner (app-side, not the printer). */
  stampTime: boolean;
}

export const PHOTOBOOTH_DEFAULT_PRINT: PhotoboothPrintConfig = {
  enabled: true,
  autoPrint: true,
  printerName: null,
  bleedScale: 1.02,
  framedEdgeInsetMm: 4,
  framedBottomExtraMm: 2.5,
  allowWifiPrinters: false,
  stampTime: true,
};

export interface PhotoboothCopyAiMode {
  title: string;
  subtitle: string;
  back: string;
  /**
   * Label for the non-AI option (regular booth photo only).
   * Use "Photocapture", "Default", etc. — not an admin `aiModes` row.
   */
  plainPhotoLabel: string;
}

export interface PhotoboothCopyBoothMode {
  title: string;
  subtitle: string;
  defaultLabel: string;
  defaultHint: string;
  physicalLabel: string;
  physicalHint: string;
  back: string;
}

/**
 * Reserved `AiStyleService` mode id: skip AI on the result screen; standard capture only.
 * Not stored in `aiModes[]` — the plain button is always shown when the AI step is enabled.
 */
export const PLAIN_PHOTO_MODE_ID = 'photocapture';

export interface PhotoboothCopyFrame {
  title: string;
  subtitle: string;
  continueLabel: string;
  skipLabel: string;
  applying: string;
}

export interface PhotoboothCopyCaption {
  title: string;
  subtitle: string;
  placeholder: string;
  continueLabel: string;
  skipLabel: string;
  applying: string;
}

export interface PhotoboothCopyHistory {
  title: string;
  empty: string;
  back: string;
  ariaOpen: string;
  filterAll: string;
  filterPhysical: string;
  filterDigital: string;
  filterOriginal: string;
  whenAll: string;
  whenToday: string;
  whenYesterday: string;
  whenWeek: string;
  whenMonth: string;
  whenCustom: string;
  deleteLabel: string;
  deleteConfirm: string;
  cancel: string;
  previewHint: string;
  reprint: string;
  makePhysical: string;
  remakePhysical: string;
  makingPhysical: string;
  originalLabel: string;
  makeFramed: string;
  remakeFramed: string;
  makingFramed: string;
  pickFrameTitle: string;
  pickFrameHint: string;
  applyFrame: string;
}

export interface PhotoboothCopyCans {
  title: string;
  subtitle: string;
  back: string;
  continue: string;
}

export interface PhotoboothCopyDetails {
  title: string;
  subtitle: string;
  formHeading: string;
  firstNameLabel: string;
  lastNameLabel: string;
  firstNamePlaceholder: string;
  lastNamePlaceholder: string;
  emailLabel: string;
  emailPlaceholder: string;
  terms: string;
  age: string;
  imageUse: string;
  marketing: string;
  continue: string;
  back: string;
}

export interface PhotoboothCopyThanks {
  title: string;
  subtitle: string;
  hint: string;
  inboxTitle: string;
  inboxBody: string;
  startOver: string;
  /** Shown while AI is still running after LOOKS GOOD. */
  processing?: string;
  /** Shown when print succeeded. */
  printed?: string;
  /** Shown when no printer / print failed. */
  printError?: string;
  /** Shown when cloud gallery is unreachable. */
  backendOffline?: string;
  /** Shown when OpenAI API key is missing. */
  apiKeyMissing?: string;
}

export interface PhotoboothCopy {
  attract: PhotoboothCopyAttract;
  cans: PhotoboothCopyCans;
  details: PhotoboothCopyDetails;
  thanks: PhotoboothCopyThanks;
  qr: PhotoboothCopyQr;
  capture: PhotoboothCopyCapture;
  result: PhotoboothCopyResult;
  history: PhotoboothCopyHistory;
  aiMode: PhotoboothCopyAiMode;
  boothMode: PhotoboothCopyBoothMode;
  frame: PhotoboothCopyFrame;
  caption: PhotoboothCopyCaption;
  frameAdjust: PhotoboothCopyPhysicalAdjust;
  physicalAdjust: PhotoboothCopyPhysicalAdjust;
}

export interface PhotoboothCopyPhysicalAdjust {
  title: string;
  hint: string;
  confirm: string;
  cancel: string;
  zoomLabel: string;
}

export interface PhotoboothAiMode {
  id: string;
  label: string;
  /** Used for prompt-only edits when inpainting is off. */
  prompt: string;
  /** Blend guest photo into pre-made background images (inpainting workflow). */
  useInpainting?: boolean;
  /** Pick a random background from `config/ai-backgrounds/{modeId}/` per generation. */
  randomizeBackground?: boolean;
  /** Prompt sent after compositing guest onto background; overrides `prompt` when inpainting. */
  inpaintPrompt?: string;
}

/** Token replaced with `branding.brandName` (or "the brand") in AI prompts. */
export const BRAND_TOKEN = '{brand}';

/** Snippet appended when a logo reference is available for AI generation. */
export const BRAND_LOGO_AI_SNIPPET =
  'Use the brand logo from the reference image(s) exactly — reproduce it on booth signage, product boxes, DJ equipment, headphones, and clothing where natural. Do not invent a different logo or mascot.';

/** Default inpainting prompt for DJ booth modes — uses `{brand}` token. */
export const DJ_INPAINT_PROMPT =
  `Seamlessly blend the person into this DJ booth environment as the featured DJ. Preserve their exact face, features, skin tone, and likeness — do not change identity. Match scene lighting, shadows, perspective, and color grade. Reproduce the brand logo on booth furniture, product boxes, and signage. Add subtle ${BRAND_TOKEN} branding on DJ headphones or shirt where natural. Photorealistic exclusive event photo. No mascots.`;

/** Fallback prompt-only DJ mode text when inpainting is disabled. */
export const DJ_PROMPT_ONLY =
  `Transform the person into a professional DJ at an exclusive event. Place them at a DJ booth with ${BRAND_TOKEN} branding on equipment, product boxes in the background, and subtle brand logos on headphones or clothing. Preserve their exact face and likeness. Photorealistic, vibrant event lighting. No mascots.`;

/** Exact prompt for the default Newspaper style (admin may duplicate or edit in JSON). */
export const NEWSPAPER_AI_PROMPT =
  'Create a newspaper cutting style front page with the main title exactly: HAPPENING NOW! Transform the person in the uploaded photo into a whimsical black-and-white vintage newspaper front page. Place them as the main portrait in the center, styled like an old engraved photograph. Preserve the overall scene framing from the source image (whole room/context), not a tighter zoom—only use a close portrait crop if the source is already cropped that way. Surround them with bold, exaggerated headline text, narrow newspaper columns, and playful subheadings. Use high-contrast black ink on pure white background, subtle paper texture, and classic serif fonts. Add quirky, magical or humorous headlines to create a charming, slightly surreal tone. Keep the layout dense, editorial, and reminiscent of an old fantasy newspaper. Ensure the subject\'s face remains recognizable but stylized to match the printed newspaper aesthetic.';

export interface PhotoboothCameraConfig {
  /**
   * auto — Canon SDK when `edsdk-bridge.exe` is present, otherwise USB / system camera.
   * sdk — force Canon SDK (falls back to system camera if bridge unavailable).
   * webcam — force USB / system camera (production option for high-end USB webcams).
   */
  source: 'auto' | 'sdk' | 'webcam';
  /** Index from EDSDK `list` when using the Canon bridge. */
  sdkCameraIndex: number;
  /** `deviceId` from `navigator.mediaDevices` when using webcam. */
  webcamDeviceId: string | null;
}

export interface PhotoboothPhotoFramesConfig {
  /** After capture, let guests pick a decorative photo frame. */
  enabled: boolean;
  /** Guest photo size inside the frame hole (1 = fill hole). */
  photoScale: number;
  /** Optional default frame filename (e.g. `onam-grma-2026.png`). */
  defaultFrameFile: string | null;
  /**
   * Frame filenames offered to guests.
   * Empty array = all frames in `config/photo-frames/`.
   */
  guestFrameFiles: string[];
  /**
   * When true, skip the frame-selection screen and automatically apply a frame.
   * Uses `defaultFrameFile` if set, otherwise picks randomly from `guestFrameFiles`
   * (or all available frames when `guestFrameFiles` is empty).
   */
  autoApplyFrame: boolean;
  /**
   * After frame pick (or auto-apply), show zoom/pan so faces sit in the opening.
   * Remake-from-original always shows this, even when this flag is off.
   */
  guestAdjustPhoto: boolean;
  /**
   * After frame pick, prompt for custom text (names / message) with an in-app keyboard.
   * Placement, color, and size are set in Admin → Frames.
   */
  guestTextEnabled: boolean;
  /** Allow skipping the text step. */
  guestTextOptional: boolean;
  /** Max characters for the guest line. */
  guestTextMaxLength: number;
  /** Optional static credit under the guest line (e.g. "by inmoment photography"). */
  guestTextCreditLine: string;
  /** Horizontal position on the print, 0–100 (0 = left, 50 = center). */
  guestTextXPercent: number;
  /** Vertical position on the print, 0–100 (0 = top). */
  guestTextYPercent: number;
  /** Guest line size as a percent of print height. */
  guestTextSizePercent: number;
  /** Guest line color (#rrggbb). */
  guestTextColor: string;
  /** Credit line color (#rrggbb). */
  guestTextCreditColor: string;
  guestTextAlign: 'left' | 'center' | 'right';
  /** Soft paint swipe behind text. Off by default — outline keeps type readable. */
  guestTextBrush: boolean;
  /** 0–1 opacity of the brushstroke when enabled. */
  guestTextBrushOpacity: number;
}

export const PHOTOBOOTH_DEFAULT_PHOTO_FRAMES: PhotoboothPhotoFramesConfig = {
  enabled: false,
  photoScale: 1,
  defaultFrameFile: 'botanical-landscape.png',
  guestFrameFiles: [],
  autoApplyFrame: false,
  guestAdjustPhoto: true,
  guestTextEnabled: false,
  guestTextOptional: true,
  guestTextMaxLength: 36,
  guestTextCreditLine: 'by inmoment photography',
  guestTextXPercent: 50,
  guestTextYPercent: 78,
  guestTextSizePercent: 3.4,
  guestTextColor: '#c9a36a',
  guestTextCreditColor: '#d8c4a0',
  guestTextAlign: 'center',
  guestTextBrush: false,
  guestTextBrushOpacity: 0.22,
};

/** Guest experience mode ids. */
export type PhotoboothBoothModeId = 'default' | 'physicalFrame';

/** Which experience buttons guests see after Tap to start. */
export interface PhotoboothGuestModesConfig {
  /** Classic digital frames / AI flow. */
  defaultEnabled: boolean;
  /** Dual cut-sheet for physical photo frames. */
  physicalFrameEnabled: boolean;
}

export const PHOTOBOOTH_DEFAULT_GUEST_MODES: PhotoboothGuestModesConfig = {
  defaultEnabled: true,
  physicalFrameEnabled: false,
};

/**
 * Dual cut-sheet for physical photo frames.
 * Landscape capture is rotated 90°, then placed twice in portrait cells (columns).
 * Cell outer size in cm is the printed ruler size on SELPHY 148×100 mm paper.
 * Gap/margins auto-fill leftover postcard space. Safe insets only move the photo
 * inside each cell. Global print bleed is not applied.
 */
export interface PhotoboothPhysicalFrameConfig {
  /** Width of each cut cell (cm). */
  cellWidthCm: number;
  /** Height of each cut cell (cm). */
  cellHeightCm: number;
  /** White inset between cell edge and decorative border (mm). */
  innerPaddingMm: number;
  /** Safe photo area inside the frame — keeps heads inside physical insert (mm). */
  safeInsetTopMm: number;
  safeInsetBottomMm: number;
  safeInsetLeftMm: number;
  safeInsetRightMm: number;
  /** Gap between the two columns (mm). */
  gapMm: number;
  /** Outer margin around the sheet (mm). */
  marginMm: number;
  /**
   * Extra white around the cut sheet when sending to SELPHY.
   * CP1500 borderless overscans ~3–5 mm; this keeps gold frames inside the paper.
   */
  printerCropInsetMm: number;
  dpi: number;
  /** Rotate landscape capture before fitting into each cell (90 or -90). */
  rotateDegrees: 90 | -90;
  /** Draw thin double-line border with corner accents inside each cell. */
  borderEnabled: boolean;
}

export const PHOTOBOOTH_DEFAULT_PHYSICAL_FRAME: PhotoboothPhysicalFrameConfig = {
  cellWidthCm: 5.3,
  cellHeightCm: 7.8,
  innerPaddingMm: 3,
  safeInsetTopMm: 0.2,
  safeInsetBottomMm: 0.2,
  safeInsetLeftMm: 3,
  safeInsetRightMm: 1,
  gapMm: 6.35,
  marginMm: 6.35,
  printerCropInsetMm: 4,
  dpi: 300,
  rotateDegrees: -90,
  borderEnabled: true,
};

/** Fields returned to the renderer (admin PIN and OpenAI API key are never included). */
export interface PhotoboothConfig {
  activeThemeId: string;
  branding: PhotoboothBranding;
  camera: PhotoboothCameraConfig;
  photoFrames: PhotoboothPhotoFramesConfig;
  gallery: PhotoboothGalleryConfig;
  print: PhotoboothPrintConfig;
  email: PhotoboothEmailConfig;
  display: PhotoboothDisplayConfig;
  cans: PhotoboothCan[];
  debug: PhotoboothDebugConfig;
  copy: PhotoboothCopy;
  capture: PhotoboothCaptureConfig;
  /** Idle timeout + unattended guest safeguards. */
  kiosk: PhotoboothKioskConfig;
  /**
   * Which guest modes are offered after Tap to start.
   * When more than one is enabled, guests pick on `/booth-mode`.
   */
  guestModes: PhotoboothGuestModesConfig;
  physicalFrame: PhotoboothPhysicalFrameConfig;
  /** When true, guests must pass the QR / code unlock screen. */
  requireQrUnlock: boolean;
  /** When true, after unlock the guest picks an AI style before capture. */
  aiGenerationEnabled: boolean;
  /**
   * When set, guests skip the style screen and this mode is auto-selected.
   * Use a mode `id` from `aiModes`, or `PLAIN_PHOTO_MODE_ID` for plain capture only.
   */
  defaultAiModeId: string | null;
  /** Modes shown after QR; each carries the prompt sent to the Images API. */
  aiModes: PhotoboothAiMode[];
  /** OpenAI Images API base, including `/v1`. Override for Azure/proxy. */
  openAiApiUrl?: string;
  /** Set only by Electron after merging config; true when `openAiApiKey` exists on disk. */
  openAiConfigured?: boolean;
}

export const PHOTOBOOTH_DEFAULT_CAMERA: PhotoboothCameraConfig = {
  source: 'auto',
  sdkCameraIndex: 0,
  webcamDeviceId: null,
};

export const PHOTOBOOTH_DEFAULT_BRANDING: PhotoboothBranding = {
  logoFile: 'zyn-logo.svg',
  aiLogoFile: null,
  cameraOverlayFile: null,
  brandName: 'ZYN',
  applyBrandToAi: true,
};

export const PHOTOBOOTH_DEFAULT_AI_MODES: PhotoboothAiMode[] = PHOTOBOOTH_DEFAULT_CANS.map((c) => ({
  id: c.id,
  label: c.label,
  prompt: c.prompt,
  useInpainting: c.useInpainting !== false,
  randomizeBackground: false,
  inpaintPrompt: c.inpaintPrompt,
}));

export const PHOTOBOOTH_DEFAULT_COPY: PhotoboothCopy = {
  attract: {
    icon: '📷',
    tagline: '',
    mainScale: 1,
    topScale: 1,
    title: 'WHEN PHOTO\nMEETS FINISH',
    subtitle: '',
    ctaLabel: 'TAP TO START',
    startAria: 'Tap to start',
    adminLink: 'Admin',
  },
  cans: {
    title: 'CHOOSE YOUR ZYN',
    subtitle: 'Select your flavor and suit up',
    back: 'Back',
    continue: 'SELECT',
  },
  details: {
    title: 'ALMOST THERE',
    subtitle: 'A FEW DETAILS &\nYOU ARE READY',
    formHeading: 'TELL US A BIT ABOUT YOURSELF',
    firstNameLabel: 'First Name',
    lastNameLabel: 'Last Name',
    firstNamePlaceholder: '',
    lastNamePlaceholder: '',
    emailLabel: 'Email Address',
    emailPlaceholder: '',
    terms: 'I agree to the Terms & Conditions and acknowledge the Privacy Policy.',
    age: '21+ confirmation',
    imageUse: 'Image-use consent',
    marketing: 'Marketing opt-in',
    continue: 'CONTINUE',
    back: 'BACK',
  },
  thanks: {
    title: 'THANK YOU!',
    subtitle: '',
    hint: '',
    inboxTitle: '',
    inboxBody: '',
    startOver: 'START OVER',
    processing: 'THANK YOU!',
    printed: 'THANK YOU!',
    printError: 'SOMETHING WENT WRONG',
    backendOffline: '',
    apiKeyMissing: 'API KEY MISSING',
  },
  qr: {
    icon: '🔐',
    title: 'Scan your QR',
    subtitle:
      'Hold your phone to the photobooth scanner to begin your photo experience.',
    scanSuccess: 'QR verified',
    footer: 'Have your registration QR ready.',
    codeLabel: 'Code',
    ok: 'OK',
    back: 'Back',
    invalidCode: 'Invalid code. Use 1234 to continue (debug).',
    debugHint: 'Debug — type ok then Enter',
    bypassCode: '1234',
  },
  capture: {
    sideTitle: 'How to pose',
    instructions: 'LOOK AT THE CAMERA AND SMILE',
    starting: 'Starting camera…',
    readyTitle: 'PHOTOBOOTH',
    readySubtitle: 'LOOK AT THE CAMERA AND SMILE',
    footerHint: 'AI applies guest’s face to F1 driver in chosen suit color',
    smileHint: 'HOLD STILL, YOUR PHOTO IS BEING CAPTURED',
    capturing: 'CAPTURING...',
    takePhoto: 'TAKE PHOTO',
  },
  result: {
    title: 'Your photo',
    loading: 'Loading…',
    savedPrefix: 'Saved:',
    retake: 'RETAKE PHOTO',
    submit: 'Done',
    confirmPhoto: 'LOOKS GOOD!',
    generateAi: 'Create AI version',
    generatingAi: 'Creating your AI image…',
    aiPreviewTitle: 'AI version',
    aiErrorPrefix: 'AI generation failed:',
    aiGalleryTitle: 'Your photos',
    galleryThumbOriginal: 'Original',
    galleryThumbAi: 'AI style',
    galleryBackToResult: 'Back to photo',
    galleryFinish: 'Finish',
    thinkingSummary: 'Preparing your image',
    thinkingStepAnalyze: 'Analysing framing and composition',
    thinkingStepPlan: 'Applying your chosen style directions',
    thinkingStepBackground: 'Selecting branded environment and compositing your photo',
    thinkingStepImage: 'Rendering with the image API',
    thinkingFootnote:
      'Runs on OpenAI Images (edit). Unlike ChatGPT, the booth cannot stream GPT‑5 “thinking” text for image jobs.',
    share: 'Share',
    sharing: 'Uploading…',
    shareQrTitle: 'Scan to view your photo',
    shareQrHint: 'Scan with your phone to open your photo — save or link your event card there.',
    shareBack: 'Back',
    uploadFailed: 'Could not upload to gallery',
    print: 'Print',
    printing: 'Printing…',
    printed: 'THANK YOU!',
    printFailed: 'Print failed',
    makePhysical: 'Make physical sheet',
    remakePhysical: 'Remake physical sheet',
    makingPhysical: 'Creating sheet…',
    physicalErrorPrefix: 'Physical sheet failed:',
    makeFramed: 'Make framed',
    remakeFramed: 'Remake framed',
    makingFramed: 'Applying frame…',
    framedErrorPrefix: 'Frame failed:',
  },
  history: {
    title: 'Photo history',
    empty: 'No photos yet — every capture on this booth appears here so you can reprint.',
    back: 'Back to start',
    ariaOpen: 'Photo history — reprint any capture',
    filterAll: 'All',
    filterPhysical: 'Physical',
    filterDigital: 'Digital',
    filterOriginal: 'Originals',
    whenAll: 'All dates',
    whenToday: 'Today',
    whenYesterday: 'Yesterday',
    whenWeek: 'Last 7 days',
    whenMonth: 'This month',
    whenCustom: 'Custom dates',
    deleteLabel: 'Delete',
    deleteConfirm: 'Delete this photo from this booth? This cannot be undone.',
    cancel: 'Cancel',
    previewHint: 'Tap a photo to preview',
    reprint: 'Reprint',
    makePhysical: 'Make physical sheet',
    remakePhysical: 'Remake physical sheet',
    makingPhysical: 'Creating sheet…',
    originalLabel: 'Original',
    makeFramed: 'Make framed',
    remakeFramed: 'Remake framed',
    makingFramed: 'Applying frame…',
    pickFrameTitle: 'Choose a frame',
    pickFrameHint: 'Applied to this original. Same overlay guests get after capture.',
    applyFrame: 'Apply frame',
  },
  aiMode: {
    title: 'Choose a style',
    subtitle: 'Pick how we transform your photo',
    back: 'Back',
    plainPhotoLabel: 'Photocapture',
  },
  boothMode: {
    title: 'Choose a mode',
    subtitle: 'How should we finish your photo?',
    defaultLabel: 'Digital frame',
    defaultHint: 'Photo with frames and styles',
    physicalLabel: 'Physical frame',
    physicalHint: 'One dual-photo sheet — print once, then cut for your frame',
    back: 'Back',
  },
  frame: {
    title: 'Choose a frame',
    subtitle: 'Pick a keepsake border for your photo',
    continueLabel: 'Use this frame',
    skipLabel: 'Skip frame',
    applying: 'Applying frame…',
  },
  frameAdjust: {
    title: 'Align photo in the frame',
    hint: 'Drag to move. Use + / − to zoom so faces sit in the opening.',
    confirm: 'Use this crop',
    cancel: 'Back',
    zoomLabel: 'Zoom',
  },
  caption: {
    title: 'Add your text',
    subtitle: 'Type a name or short message for the frame',
    placeholder: 'Your names or message',
    continueLabel: 'Continue',
    skipLabel: 'Skip text',
    applying: 'Creating keepsake…',
  },
  physicalAdjust: {
    title: 'Adjust photo in the frame',
    hint: 'Drag to move. Use + / − to zoom and crop extra background. Both prints stay identical. Each cell prints at the centimetre size set in Admin.',
    confirm: 'Create sheet',
    cancel: 'Back',
    zoomLabel: 'Zoom',
  },
};
