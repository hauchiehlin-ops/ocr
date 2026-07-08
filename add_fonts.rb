require 'xcodeproj'

project_path = '/Users/barretlin/GitProjects/OCR/platforms/macos/OCREditor.xcodeproj'
project = Xcodeproj::Project.open(project_path)

target = project.targets.find { |t| t.name == 'OCREditor' }
resources_build_phase = target.resources_build_phase

group = project.main_group.find_subpath('OCREditor/Resources/Fonts', true)

['NotoSansTC-Regular.otf', 'NotoSerifTC-Regular.otf'].each do |font_name|
  font_path = "/Users/barretlin/GitProjects/OCR/assets/fonts/#{font_name}"
  file_ref = group.new_reference(font_path)
  
  # Add to resources build phase if not already there
  unless resources_build_phase.files_references.include?(file_ref)
    resources_build_phase.add_file_reference(file_ref)
  end
end

target.build_configurations.each do |config|
  config.build_settings['INFOPLIST_KEY_ATSApplicationFontsPath'] = '.'
end

project.save
puts "Added fonts and ATSApplicationFontsPath to Xcode project"
