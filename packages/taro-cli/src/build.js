const fs = require('fs-extra')
const path = require('path')
const chalk = require('chalk')

const Util = require('./util')
const CONFIG = require('./config')

const appPath = process.cwd()

/* ctw do not merge */
async function build (args, buildConfig) {
/* ctw do not merge */
  const { type, watch } = buildConfig
  const outputPath = path.join(appPath, CONFIG.OUTPUT_DIR)
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath)
  } else {
    Util.emptyDirectory(outputPath)
  }
  switch (type) {
    case Util.BUILD_TYPES.H5:
      buildForH5({ watch })
      break
    case Util.BUILD_TYPES.WEAPP:
      /* ctw do not merge */
      await buildForWeapp({ watch })
      break
      /* ctw do not merge */
    case Util.BUILD_TYPES.RN:
      buildForRN({ watch })
      break
    case Util.BUILD_TYPES.UI:
      buildForUILibrary({ watch })
      break
    default:
      console.log(chalk.red('输入类型错误，目前只支持weapp/h5/rn三端类型'))
  }
}

/* ctw do not merge */
function buildForWeapp ({ watch }) {
  let weapp = require('./weapp')
  await weapp.build({ watch })
}
/* ctw do not merge */

function buildForH5 (buildConfig) {
  require('./h5').build(buildConfig)
}

function buildForRN ({ watch }) {
  require('./rn').build({ watch })
}

function buildForUILibrary ({ watch }) {
  require('./ui').build({ watch })
}

module.exports = build
