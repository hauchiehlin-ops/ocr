require 'xcodeproj'

project_path = '/Users/barretlin/GitProjects/OCR/platforms/macos/OCREditor.xcodeproj'
project = Xcodeproj::Project.open(project_path)

# Find the target
target = project.targets.find { |t| t.name == 'OCREditor' }
if target.nil?
  puts "Target 'OCREditor' not found"
  exit 1
end

# Find the group Models
models_group = project.main_group.find_subpath(File.join('OCREditor', 'Models'), true)
models_group.set_source_tree('<group>')

# Add the file
file_path = '/Users/barretlin/GitProjects/OCR/platforms/macos/OCREditor/Models/SettingsSyncManager.swift'
file_ref = models_group.new_reference(file_path)

# Add to target compile sources
target.source_build_phase.add_file_reference(file_ref)

project.save
puts "Added SettingsSyncManager.swift to target"
