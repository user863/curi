# Adds the widget extension to the generated Xcode project (app/ios is generated and not committed, so run this after
# `expo prebuild`). Safe to repeat.
#   GEM_HOME=$(ls -d /opt/homebrew/Cellar/cocoapods/*/libexec | head -1) /opt/homebrew/opt/ruby/bin/ruby widget/add_target.rb
require 'xcodeproj'

NAME = 'CuriWidget'
project = Xcodeproj::Project.open('ios/Commonplace.xcodeproj')
exit if project.targets.any? { |t| t.name == NAME }

app = project.targets.find { |t| t.name == 'Commonplace' }
target = project.new_target(:app_extension, NAME, :ios, '18.0')
team = app.build_configurations.first.build_settings['DEVELOPMENT_TEAM']

group = project.main_group.new_group(NAME, '../widget')
target.add_file_references([group.new_file('CuriWidget.swift')])
group.new_file('Info.plist')

target.build_configurations.each do |config|
  config.build_settings.merge!(
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.johannbraun.commonplace.widget',
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'INFOPLIST_FILE' => '../widget/Info.plist',
    'GENERATE_INFOPLIST_FILE' => 'NO',
    'DEVELOPMENT_TEAM' => team,
    'CODE_SIGN_STYLE' => 'Automatic',
    'SWIFT_VERSION' => '5.0',
    'TARGETED_DEVICE_FAMILY' => '1',
    'IPHONEOS_DEPLOYMENT_TARGET' => '18.0',
    'SKIP_INSTALL' => 'YES',
    'LD_RUNPATH_SEARCH_PATHS' => '$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks',
    'MARKETING_VERSION' => '1.0',
    'CURRENT_PROJECT_VERSION' => '1'
  )
end

app.add_dependency(target)
embed = app.new_copy_files_build_phase('Embed Foundation Extensions')
embed.symbol_dst_subfolder_spec = :plug_ins
file = embed.add_file_reference(target.product_reference)
file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
project.save
puts "added #{NAME}"
