// The ranking, pacing and speech logic is shared with the web app in ../js; Metro reads it from there.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../js')];
module.exports = config;
