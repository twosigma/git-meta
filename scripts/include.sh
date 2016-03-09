echo "Setting up include demo"
{
    rm -rf include-demo
    mkdir include-demo
    cd include-demo
    sl init meta
    git init x
    cd x
    touch foo
    git add foo
    git com -m "first x"
    cd ..
    git init y
    cd y
    touch bar
    git add bar
    git com -m "first y"
    cd ../meta
    git co -b my-branch
} &> /dev/null
