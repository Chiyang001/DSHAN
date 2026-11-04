#include <node.h>

// Installed in nativeLibraryDir so Android permits executing this child.
int main(int argc, char** argv) {
    return node::Start(argc, argv);
}
