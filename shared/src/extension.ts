/**
 * Stable identity for the unpacked extension.
 *
 * EXTENSION_PUBLIC_KEY goes into manifest.key. Chrome derives the extension ID
 * from it, so the ID stays the same on every machine and every load path.
 * The companion installer and the dev harness use EXTENSION_ID.
 *
 * Regenerate (only if you must; it changes the ID everywhere):
 *   openssl genrsa -out key.pem 2048
 *   openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A          # -> EXTENSION_PUBLIC_KEY
 *   openssl rsa -in key.pem -pubout -outform DER | shasum -a 256 | head -c 32 | tr '0-9a-f' 'a-p'   # -> EXTENSION_ID
 */

export const EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwyv0x0HFfqVZGFChcm86zupr6txRV/w5epeBfznwy1YpyABzHxtMxZQjGJc7jgHtPpfowIdxJ3hKFMfleuCM9iJUOFP6SGJXi+7inqZkx3s9MnxZ4OsTr8el8ACHSMl3i79J+ohM9OHbL57XGkJlOGYAWZc7uVAEfN1XbwNUW5Hu/2bbm7NCx4BRyhJAnfzHZ+f8sMDKQ1iqgj2G6QZJdCPS60fkY/Jcv4UkU/ni9nHuzkMTYVDZ0SBnC3CS5cEAjjhyTnaX6wAG8HHCfFgtAS6jX5vCvSRg5DK4UpHxv5hSkaSoQkmOZ3FcJKfZlJwJs5AfUo7dYVMSn6MuepvgPQIDAQAB';

export const EXTENSION_ID = 'hoadedohbfjjmkajibiafgoajoicjdba';

export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

/** Dev harness origins allowed to connect (externally_connectable). */
export const HARNESS_ORIGINS = ['http://localhost/*', 'http://127.0.0.1/*'];

export const HARNESS_PORT = 4173;
export const FIXTURE_PORT = 4174;
