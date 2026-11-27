'use strict';

function httpStatusFromGh(stderr, exitStatus) {
  const text = String(stderr || '');
  const match = text.match(/\(HTTP (\d{3})\)/);
  if (match) return parseInt(match[1], 10);
  return null;
}

module.exports = { httpStatusFromGh };