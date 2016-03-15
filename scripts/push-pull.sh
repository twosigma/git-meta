echo "Setting up push-pull demo"
{
    rm -rf demo
    mkdir demo
    cd demo
    git init --bare meta-bare
    git init --bare x-bare
    git init --bare y-bare
    git clone meta-bare meta
    git clone x-bare x
    git clone y-bare y
    cd meta
    touch README.md
    git add README.md
    git com -m first
    git push origin master
    cd ../x
    touch foo
    git add foo
    git com -m "first x"
    git push origin master
    cd ../y
    touch bar
    git add bar
    git com -m "first y"
    git push origin master
    cd ../meta
    git meta include ../x-bare x
    git meta include ../y-bare y
    git meta commit -m "added subs"
    git meta push
    cd ..
    git clone meta-bare other-meta
    cd other-meta
    git meta open x
    cd x
    touch moo
    git add moo
    cd ..
    git meta commit -m "moooo"
    git meta push
    cd ..
    cd meta
    cd x
    echo aaa >> foo
} &> /dev/null
