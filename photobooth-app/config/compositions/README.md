Each ZYN can uses its **own** F1 scene. The booth never borrows another flavor's image.

Put files here:

```
config/compositions/
  cool-mint/composition.jpg + composition.json
  wintergreen/composition.jpg + composition.json
  peppermint/composition.jpg + composition.json
  spearmint/composition.jpg + composition.json
  cinnamon/composition.jpg + composition.json
  citrus/composition.jpg + composition.json
  _shared/                 ← placeholder only, used if a can folder has no image yet
```

AI is a **head swap** on that can's scene:

- Guest capture supplies the face/head
- The driver's body, suit, pose, car, and location stay from **this can's** composition
- Face box is `composition.json` → `face` (percent of that scene). Each can can have a different box.

Admin → Cans: upload a unique scene per flavor and nudge the green head oval.
