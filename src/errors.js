class BamError extends Error {}

/** Error caused by encountering a part of the BAM spec that has not yet been implemented */
class BamUnimplementedError extends Error {}

/** An error caused by malformed data.  */
class BamMalformedError extends BamError {}

/**
 * An error caused by attempting to read beyond the end of the defined data.
 */
class BamBufferOverrunError extends BamMalformedError {}

/**
 * An error caused by data being too big, exceeding a size limit.
 */
class BamSizeLimitError extends BamError {}

/**
 * An invalid argument was supplied to a bam-js method or object.
 */
class BamArgumentError extends BamError {}

module.exports = {
  BamBufferOverrunError,
  BamMalformedError,
  BamUnimplementedError,
  BamSizeLimitError,
  BamArgumentError,
}
