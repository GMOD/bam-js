<a name="1.1.8"></a>
## [1.1.8](https://github.com/GMOD/bam-js/compare/v1.1.7...v1.1.8) (2021-05-21)



- Fix types for yieldThreadTime

<a name="1.1.7"></a>

## [1.1.7](https://github.com/GMOD/bam-js/compare/v1.1.6...v1.1.7) (2021-05-21)

- New param yieldThreadTime to constructor to yield while processing

<a name="1.1.6"></a>

## [1.1.6](https://github.com/GMOD/bam-js/compare/v1.1.5...v1.1.6) (2021-02-20)

- Add qualRaw function on records for getting raw qual score array instead of string

<a name="1.1.5"></a>

## [1.1.5](https://github.com/GMOD/bam-js/compare/v1.1.4...v1.1.5) (2020-12-11)

- Allow getHeaderText to accept cancellation options

<a name="1.1.4"></a>

## [1.1.4](https://github.com/GMOD/bam-js/compare/v1.1.3...v1.1.4) (2020-12-11)

- Add canMergeBlocks to CSI code (already existed in BAI)
- Add suggestion from @jrobinso about reg2bins modification for memory saving (Thanks!)
- Add getHeaderText() method for getting a text string of the header data

<a name="1.1.3"></a>

## [1.1.3](https://github.com/GMOD/bam-js/compare/v1.1.2...v1.1.3) (2020-10-29)

- Fix usage of feature.get('seq'), was using feature.getReadBases before this

<a name="1.1.2"></a>

## [1.1.2](https://github.com/GMOD/bam-js/compare/v1.1.1...v1.1.2) (2020-10-02)

- Fix signedness in BAM tags (#65)
- Remove unused seq_reverse_complemented tag from \_tags()

<a name="1.1.1"></a>

## [1.1.1](https://github.com/GMOD/bam-js/compare/v1.1.0...v1.1.1) (2020-09-20)

- Remove JBrowse specific results from tags

<a name="1.1.0"></a>

# [1.1.0](https://github.com/GMOD/bam-js/compare/v1.0.42...v1.1.0) (2020-08-28)

- Add support for the CG tag for long CIGAR strings

<a name="1.0.42"></a>

## [1.0.42](https://github.com/GMOD/bam-js/compare/v1.0.41...v1.0.42) (2020-08-19)

- Small bugfix for Htsget specifically

<a name="1.0.41"></a>

## [1.0.41](https://github.com/GMOD/bam-js/compare/v1.0.40...v1.0.41) (2020-08-19)

- Add htsget example
- Support opts object to getHeader allowing things like auth headers to be passed right off the bat

<a name="1.0.40"></a>

## [1.0.40](https://github.com/GMOD/bam-js/compare/v1.0.39...v1.0.40) (2020-07-30)

<a name="1.0.39"></a>

## [1.0.39](https://github.com/GMOD/bam-js/compare/v1.0.38...v1.0.39) (2020-07-30)

- Don't use origin master in the follow-tags postpublish command for cleaner version publishing

<a name="1.0.38"></a>

## [1.0.38](https://github.com/GMOD/bam-js/compare/v1.0.37...v1.0.38) (2020-07-30)

- Direct construction of qual/seq toString
- Improve performance of the uniqueID calculation for pathological cases where there are tons of bins

<a name="1.0.37"></a>

## [1.0.37](https://github.com/GMOD/bam-js/compare/v1.0.36...v1.0.37) (2020-06-06)

- Typescript only release: export BamRecord types

<a name="1.0.36"></a>

## [1.0.36](https://github.com/GMOD/bam-js/compare/v1.0.35...v1.0.36) (2020-03-05)

- Adds a shortcut to stop parsing chunks after a record is detected to be outside the requested range while decoding

<a name="1.0.35"></a>

## [1.0.35](https://github.com/GMOD/bam-js/compare/v1.0.34...v1.0.35) (2020-02-04)

- Update scheme used to calculate unique fileOffset based IDs using @gmod/bgzf-filehandle updates

<a name="1.0.34"></a>

## [1.0.34](https://github.com/GMOD/bam-js/compare/v1.0.33...v1.0.34) (2020-01-24)

- Small fix for using id() instead of .get('id') for weird SAM records containing ID field

<a name="1.0.33"></a>

## [1.0.33](https://github.com/GMOD/bam-js/compare/v1.0.32...v1.0.33) (2020-01-24)

- Perform decoding of entire chunk up front to aid caching, reverts change in 1.0.29

<a name="1.0.32"></a>

## [1.0.32](https://github.com/GMOD/bam-js/compare/v1.0.31...v1.0.32) (2019-11-16)

- Add a speed improvement for long reads by pre-allocating sequence/quality scores array

<a name="1.0.31"></a>

## [1.0.31](https://github.com/GMOD/bam-js/compare/v1.0.30...v1.0.31) (2019-11-07)

- Fix example of the "ID" field failing to return the right data

<a name="1.0.30"></a>

## [1.0.30](https://github.com/GMOD/bam-js/compare/v1.0.29...v1.0.30) (2019-11-07)

- Add fix that was causing the parser to not return all tags from the \_tags API

<a name="1.0.29"></a>

## [1.0.29](https://github.com/GMOD/bam-js/compare/v1.0.28...v1.0.29) (2019-10-31)

- Decoding of the BAM records at time of use instead of entire chunk decoded up front
- Alternate chunk merging strategy inspired by igv.js code

<a name="1.0.28"></a>

## [1.0.28](https://github.com/GMOD/bam-js/compare/v1.0.27...v1.0.28) (2019-10-29)

- Add CSI index block merging
- Change unique ID generator to be smaller numeric IDs

<a name="1.0.27"></a>

## [1.0.27](https://github.com/GMOD/bam-js/compare/v1.0.26...v1.0.27) (2019-10-10)

- Make feature IDs become generated based relative to the exact bgzip block

<a name="1.0.26"></a>

## [1.0.26](https://github.com/GMOD/bam-js/compare/v1.0.25...v1.0.26) (2019-10-01)

- Restore issue with getRecordsForRange not returning all features (#44)
- Fix compatibility with electron (#43)
- Fix usage of feature.get('seq')

<a name="1.0.25"></a>

## [1.0.25](https://github.com/GMOD/bam-js/compare/v1.0.24...v1.0.25) (2019-09-29)

- Fixed some typescript typings

<a name="1.0.24"></a>

## [1.0.24](https://github.com/GMOD/bam-js/compare/v1.0.22...v1.0.24) (2019-09-27)

- Added typescript typings

<a name="1.0.23"></a>

## [1.0.22](https://github.com/GMOD/bam-js/compare/v1.0.20...v1.0.22) (2019-09-27)

- Added typescript typings
- Botched release, was removed from npm

<a name="1.0.22"></a>

## [1.0.22](https://github.com/GMOD/bam-js/compare/v1.0.20...v1.0.22) (2019-09-03)

- Fixed issue with features having different IDs across different chunks (#36)

<a name="1.0.21"></a>

## [1.0.21](https://github.com/GMOD/bam-js/compare/v1.0.20...v1.0.21) (2019-08-06)

- Add a fix for the small chunk unpacking re-seeking in the same bgzf block repeatedly (#35)

<a name="1.0.20"></a>

## [1.0.20](https://github.com/GMOD/bam-js/compare/v1.0.19...v1.0.20) (2019-06-06)

- Added a method for smaller chunk unpacking, by modifying the header parsing to return smaller chunks and the bgzf unzipping to respect chunk boundaries (#30)
- Use fileOffset as bam feature ID which previously was crc32 of the BAM buffer which consequently speeds up processing and allows exact duplicate features

## [1.0.19](https://github.com/GMOD/bam-js/compare/v1.0.18...v1.0.19) (2019-05-30)

- Added lineCount and hasRefSeq functions to BamFile, each accepting a string seqName
- Fixed aborting on index retrieval code

## [1.0.18](https://github.com/GMOD/bam-js/compare/v1.0.17...v1.0.18) (2019-05-01)

- Bump generic-filehandle to 1.0.9 to fix error with using native fetch (global fetch needed to be bound)
- Bump abortable-promise-cache to 1.0.1 version to fix error with using native fetch and abort signals

## [1.0.17](https://github.com/GMOD/bam-js/compare/v1.0.16...v1.0.17) (2019-04-28)

- Fix wrong number of arguments being passed to the readRefSeqs file read() invocation resulting in bad range requests

## [1.0.16](https://github.com/GMOD/bam-js/compare/v1.0.15...v1.0.16) (2019-04-28)

- Added indexCov algorithm to retrieve approximate coverage of the BAM inferred from the size of the BAI linear index bins
- Fixed abortSignal on read() calls
- Updated API to allow bamUrl/baiUrl/csiUrl

## [1.0.15](https://github.com/GMOD/bam-js/compare/v1.0.14...v1.0.15) (2019-04-04)

- Added check for too large of chromosomes in the bai bins
- Added aborting support (thanks @rbuels)
- Refactored index file class

<a name="1.0.14"></a>

## [1.0.14](https://github.com/GMOD/bam-js/compare/v1.0.13...v1.0.14) (2019-01-04)

- Add hasRefSeq for CSI indexes

<a name="1.0.13"></a>

## [1.0.13](https://github.com/GMOD/bam-js/compare/v1.0.12...v1.0.13) (2018-12-25)

- Use ascii decoding for read names
- Fix error with large BAM headers with many refseqs

<a name="1.0.12"></a>

## [1.0.12](https://github.com/GMOD/bam-js/compare/v1.0.11...v1.0.12) (2018-11-25)

- Faster viewAsPairs operation

<a name="1.0.11"></a>

## [1.0.11](https://github.com/GMOD/bam-js/compare/v1.0.10...v1.0.11) (2018-11-23)

- Fix for ie11

<a name="1.0.10"></a>

## [1.0.10](https://github.com/GMOD/bam-js/compare/v1.0.9...v1.0.10) (2018-11-18)

- Add a maxInsertSize parameter to getRecordsForRange

<a name="1.0.9"></a>

## [1.0.9](https://github.com/GMOD/bam-js/compare/v1.0.8...v1.0.9) (2018-11-16)

- Allow bases other than ACGT to be decoded
- Make viewAsPairs only resolve pairs on given refSeq unless pairAcrossChr is enabled for query

<a name="1.0.8"></a>

## [1.0.8](https://github.com/GMOD/bam-js/compare/v1.0.7...v1.0.8) (2018-10-31)

- Add getPairOrientation for reads

<a name="1.0.7"></a>

## [1.0.7](https://github.com/GMOD/bam-js/compare/v1.0.6...v1.0.7) (2018-10-19)

- Re-release of 1.0.6 due to build machinery error

<a name="1.0.6"></a>

## [1.0.6](https://github.com/GMOD/bam-js/compare/v1.0.5...v1.0.6) (2018-10-19)

- Add bugfix for where bytes for an invalid request returns 0 resulting in pako unzip errors

<a name="1.0.5"></a>

## [1.0.5](https://github.com/GMOD/bam-js/compare/v1.0.4...v1.0.5) (2018-10-16)

- Add a bugfix for pairing reads related to adding duplicate records to results

<a name="1.0.4"></a>

## [1.0.4](https://github.com/GMOD/bam-js/compare/v1.0.3...v1.0.4) (2018-10-13)

- Support pairing reads
- Fix pseudobin parsing containing feature count on certain BAM files

<a name="1.0.3"></a>

## [1.0.3](https://github.com/GMOD/bam-js/compare/v1.0.2...v1.0.3) (2018-09-25)

- Remove @gmod/tabix dependency

<a name="1.0.2"></a>

## [1.0.2](https://github.com/GMOD/bam-js/compare/v1.0.1...v1.0.2) (2018-09-25)

- Fix CSI indexing code

<a name="1.0.1"></a>

## [1.0.1](https://github.com/GMOD/bam-js/compare/v1.0.0...v1.0.1) (2018-09-24)

- Rename hasDataForReferenceSequence to hasRefSeq

<a name="1.0.0"></a>

# 1.0.0 (2018-09-24)

- Initial implementation of BAM parsing code
