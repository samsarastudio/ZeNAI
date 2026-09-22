const fs = require('fs');
const p = require('path').join(__dirname, '..', 'config', 'photobooth-config.default.json');
const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const prompt =
  "Clean seamless head replacement: guest likeness at the same size as the original driver head (not larger). No oval outline. Keep the driver's body and scene.";
const inpaint =
  'CLEAN SEAMLESS HEAD REPLACEMENT. Image 1 is this can\'s F1 scene with a small guest-head reference on the driver. Image 2 is a tight crop of the guest\'s real head. Replace the driver head with the guest at NATURAL PROPORTION — the head must match the original driver head size relative to the shoulders (do not enlarge). Exact guest likeness: eyes, nose, mouth, jaw, skin, hair. Completely erase the old driver head/hair. NO oval outline, cutout edge, mask ring, or halo. Blend the neck into the suit collar only. Keep the driver\'s body, crossed arms, hands, racing suit, pose, car, pit, camera angle, and lighting unchanged. Do not copy guest clothing or booth background.';
for (const c of j.cans || []) {
  c.prompt = prompt;
  c.inpaintPrompt = inpaint;
}
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
console.log('ok cans', (j.cans || []).length, 'firstByte', fs.readFileSync(p)[0]);
