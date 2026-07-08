require 'xcodeproj'

project_path = '/Users/barretlin/GitProjects/OCR/platforms/macos/OCREditor.xcodeproj'
project = Xcodeproj::Project.open(project_path)

target = project.targets.find { |t| t.name == 'OCREditor' }

target.build_configurations.each do |config|
  ldflags = config.build_settings['OTHER_LDFLAGS'] || ['$(inherited)']
  if ldflags.is_a?(String)
    ldflags = [ldflags]
  end
  unless ldflags.include?('-lsqlite3')
    ldflags << '-lsqlite3'
  end
  config.build_settings['OTHER_LDFLAGS'] = ldflags
end

project.save
puts "Added -lsqlite3 to OTHER_LDFLAGS"
