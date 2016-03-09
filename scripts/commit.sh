echo "Setting up 'slim commit' demo"
{
    rm -rf commit-demo
    mkdir commit-demo
    cd commit-demo
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
    cd ..
    cd meta
    sl include ../x x
    sl include ../y y
    sl commit -m "added subs"
} &> /dev/null
