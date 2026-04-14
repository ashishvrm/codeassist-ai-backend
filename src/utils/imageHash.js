/**
 * Perceptual image hashing for frame diffing.
 * Uses average-hash algorithm: resize to 8x8 grayscale, compute mean, generate 64-bit hash.
 * @module imageHash
 */

const sharp = require('sharp');

/**
 * Compute a perceptual hash of an image buffer.
 * @param {Buffer} imageBuffer - Raw image buffer (JPEG/PNG)
 * @returns {Promise<string>} 64-character binary hash string
 */
async function computeHash(imageBuffer) {
  const { data } = await sharp(imageBuffer)
    .resize(8, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = Array.from(data);
  const mean = pixels.reduce((sum, val) => sum + val, 0) / pixels.length;
  return pixels.map((p) => (p >= mean ? '1' : '0')).join('');
}

/**
 * Compute the Hamming distance between two hash strings.
 * @param {string} hashA - First hash
 * @param {string} hashB - Second hash
 * @returns {number} Number of differing bits
 */
function hammingDistance(hashA, hashB) {
  if (hashA.length !== hashB.length) return 64;
  let distance = 0;
  for (let i = 0; i < hashA.length; i++) {
    if (hashA[i] !== hashB[i]) distance++;
  }
  return distance;
}

/**
 * Compute similarity between two hashes as a value between 0 and 1.
 * @param {string} hashA - First hash
 * @param {string} hashB - Second hash
 * @returns {number} Similarity ratio (1.0 = identical)
 */
function similarity(hashA, hashB) {
  if (!hashA || !hashB) return 0;
  const dist = hammingDistance(hashA, hashB);
  return 1 - dist / 64;
}

module.exports = { computeHash, hammingDistance, similarity };
