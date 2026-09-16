// ── photo helpers (shared by the application form and the Admin panel) ──────
// Compress the chosen photo client-side (max 1024px, JPEG q0.85) so uploads,
// the database, and the admin's email attachment all stay small.

export const MAX_FILE_BYTES = 6 * 1024 * 1024; // keep in sync with server MAX_PHOTO_BYTES

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(blob);
  });
}

export async function compressPhoto(file) {
  if (file.type === 'image/gif') {
    // keep animations intact — send the original
    return { mime: 'image/gif', data: await blobToBase64(file), preview: URL.createObjectURL(file) };
  }

  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    image.src = url;
  });

  const MAX_SIDE = 1024;
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width  = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#111114'; // flatten transparency onto a dark backdrop
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { mime: 'image/jpeg', data: dataUrl.split(',')[1], preview: dataUrl };
}
