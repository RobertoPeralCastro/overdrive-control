/**
 * A picture for each car, so players can tell which physical car is theirs.
 * The player can pick a photo (gallery or camera); otherwise a drawing in the car's colour with
 * its initial is used. Photos are shrunk and kept in this phone's storage, keyed by the car's
 * Bluetooth id (stable for this site).
 */

const KEY = 'overdrive.avatar.';
const SIZE = 192;

export function savedAvatar(carId: string): string | undefined {
  try {
    return localStorage.getItem(KEY + carId) ?? undefined;
  } catch {
    return undefined;
  }
}

export function forgetAvatar(carId: string): void {
  try {
    localStorage.removeItem(KEY + carId);
  } catch {
    /* storage blocked */
  }
}

/** Drawing used until the player picks a photo: a car seen from above, in its colour. */
export function defaultAvatar(name: string, color: string): string {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
    <rect width="96" height="96" rx="20" fill="#1b2130"/>
    <rect x="30" y="10" width="36" height="76" rx="14" fill="${color}"/>
    <rect x="35" y="22" width="26" height="16" rx="5" fill="rgba(0,0,0,.45)"/>
    <rect x="22" y="18" width="8" height="18" rx="3" fill="#0b0d12"/><rect x="66" y="18" width="8" height="18" rx="3" fill="#0b0d12"/>
    <rect x="22" y="60" width="8" height="18" rx="3" fill="#0b0d12"/><rect x="66" y="60" width="8" height="18" rx="3" fill="#0b0d12"/>
    <text x="48" y="70" font-family="Segoe UI,system-ui,sans-serif" font-size="22" font-weight="800" text-anchor="middle" fill="#0b0d12">${initial}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function avatarFor(carId: string, name: string, color: string): string {
  return savedAvatar(carId) ?? defaultAvatar(name, color);
}

/** Opens the gallery/camera, crops the photo to a square, shrinks it and stores it. */
export function pickAvatar(carId: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return resolve(undefined);
      try {
        const bitmap = await createImageBitmap(file);
        const side = Math.min(bitmap.width, bitmap.height);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = SIZE;
        canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
        const url = canvas.toDataURL('image/jpeg', 0.82);
        try {
          localStorage.setItem(KEY + carId, url);
        } catch {
          /* storage full or blocked: still show it this session */
        }
        resolve(url);
      } catch {
        resolve(undefined);
      }
    });
    input.click();
  });
}
