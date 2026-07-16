import slugifyLib from 'slugify';

export function slugify(value: string) {
  return slugifyLib(value || '', { lower: true, strict: true }).slice(0, 180);
}
