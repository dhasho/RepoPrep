'use strict'

// Classifies LF-delimited child stdout lines only. It confers no authority,
// parses no message, and performs no I/O. Each child gets one private instance.
function createSemanticChildLineClassifier() {
  let firstPhysicalLine = true
  return Object.freeze({
    classify(line) {
      const first = firstPhysicalLine
      firstPhysicalLine = false
      if (!Buffer.isBuffer(line)) return 'invalid-blank'
      if (line.length === 1 && line[0] === 13) return first ? 'preamble' : 'invalid-blank'
      if (line.length === 0) return 'invalid-blank'
      return 'message'
    }
  })
}

module.exports = { createSemanticChildLineClassifier }
