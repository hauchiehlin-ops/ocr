cmake_minimum_required(VERSION 3.22.1)

project("ocreditor")

set(CORE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../core")

include_directories(${CORE_DIR}/include)
include_directories(${CORE_DIR}/src)

include_directories(${CORE_DIR}/third_party/sqlite)

file(GLOB_RECURSE CORE_SRCS "${CORE_DIR}/src/*.cpp")
set(MINIZ_SRC "${CORE_DIR}/src/vendor/miniz/miniz.c")
set(SQLITE_SRC "${CORE_DIR}/third_party/sqlite/sqlite3.c")

add_library(
        ocreditor
        SHARED
        OCREngineBridge.cpp
        ${CORE_SRCS}
        ${SQLITE_SRC}
        ${MINIZ_SRC}
)

find_library(
        log-lib
        log)

find_library(
        jnigraphics-lib
        jnigraphics)

target_link_libraries(
        ocreditor
        ${log-lib}
        ${jnigraphics-lib})
