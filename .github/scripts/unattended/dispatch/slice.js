'use strict';

const pathPolicy = require('./path-policy');

function defaultSlices(planFiles) {
  return [{ index: 0, files: planFiles.slice() }];
}

module.exports = {
  ...pathPolicy,
  defaultSlices,
};