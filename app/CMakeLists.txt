cmake_minimum_required(VERSION 3.22.1)
project(dsh_android)

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION
    ${CMAKE_CURRENT_LIST_DIR}/src/main/jniLibs/${ANDROID_ABI}/libnode.so)
add_library(dshbridge SHARED src/main/cpp/dshbridge.cpp)
target_include_directories(dshbridge PRIVATE libnode/include/node)
target_link_libraries(dshbridge node log)
add_executable(dshnode src/main/cpp/node-main.cpp)
set_target_properties(dshnode PROPERTIES OUTPUT_NAME libdshnode.so BUILD_RPATH "$ORIGIN")
target_include_directories(dshnode PRIVATE libnode/include/node)
target_link_libraries(dshnode node)
target_link_options(dshnode PRIVATE "-Wl,-z,max-page-size=16384" "-Wl,-z,common-page-size=16384")
# AGP packages shared-library targets. Copy the executable to a generated JNI
# source directory as well, retaining its lib*.so name for APK extraction.
add_custom_command(TARGET dshnode POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_CURRENT_LIST_DIR}/build/generated/node-jni/${ANDROID_ABI}"
    COMMAND ${CMAKE_COMMAND} -E copy "$<TARGET_FILE:dshnode>" "${CMAKE_CURRENT_LIST_DIR}/build/generated/node-jni/${ANDROID_ABI}/libdshnode.so")
add_library(dshflock SHARED src/main/cpp/flock.cpp)
target_include_directories(dshflock PRIVATE libnode/include/node)
target_link_libraries(dshflock node)

# Build node-pty against Android's bionic instead of shipping a glibc prebuild.
add_library(dshpty SHARED ../runtime/node_modules/node-pty/src/unix/pty.cc)
target_include_directories(dshpty PRIVATE libnode/include/node ../runtime/node_modules/node-addon-api)
target_compile_definitions(dshpty PRIVATE NODE_GYP_MODULE_NAME=dshpty NAPI_CPP_EXCEPTIONS)
target_compile_options(dshpty PRIVATE -fexceptions)
target_link_libraries(dshpty node)

# NDK r27 and older need both flags: LOAD alignment and the RELRO end
# must be compatible with 16 KB pages. This also works on 4 KB devices.
foreach(target dshbridge dshflock dshpty)
    target_link_options(${target} PRIVATE
        "-Wl,-z,max-page-size=16384"
        "-Wl,-z,common-page-size=16384")
endforeach()
