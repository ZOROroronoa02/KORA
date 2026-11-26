export const BCRYPT_MAX_PASSWORD_BYTES = 72;

export function passwordFitsBcrypt(password: string) {
  return Buffer.byteLength(password, "utf8") <= BCRYPT_MAX_PASSWORD_BYTES;
}

export function passwordMeetsRegistrationPolicy(password: string) {
  return Array.from(password).length >= 12 && passwordFitsBcrypt(password);
}
