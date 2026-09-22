cmake_minimum_required(VERSION 3.16)
project(edsdk_bridge CXX)

set(CMAKE_CXX_STANDARD 17)

# Point to the extracted Canon Windows x64 SDK folder (contains Library/EDSDK.lib and Dll/)
if(NOT DEFINED EDSDK_ROOT)
  set(EDSDK_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../EDSDK_v13.20.10_Windows/EDSDK_64" CACHE PATH "Path to EDSDK_64 (Canon)")
endif()

set(EDSDK_HEADER "${CMAKE_CURRENT_SOURCE_DIR}/../../../EDSDK_v13.20.10_Windows/EDSDK/Header")

add_executable(edsdk-bridge main.cpp)

target_include_directories(edsdk-bridge PRIVATE "${EDSDK_HEADER}")

if(MSVC)
  target_link_libraries(edsdk-bridge PRIVATE "${EDSDK_ROOT}/Library/EDSDK.lib")
  add_custom_command(TARGET edsdk-bridge POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "${EDSDK_ROOT}/Dll"
      $<TARGET_FILE_DIR:edsdk-bridge>
  )
else()
  message(FATAL_ERROR "Windows MSVC build only for EDSDK bridge.")
endif()
